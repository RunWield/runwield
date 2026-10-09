import { assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import {
    fauxAssistantMessage,
    type FauxResponseFactory,
    fauxText,
    fauxToolCall,
    getCurrentSystemPrompt,
    type TranscriptContext,
} from "@earendil-works/pi-ai";
import {
    loadArchivedPlan,
    loadPlan,
    parsePlanFrontMatter,
    resolveSiblingChildPlanDependencies,
    savePlan,
    updatePlanFrontMatter,
} from "../../plan-store.js";
import { createSessionRuntime, type SessionRuntime } from "../../shared/session/session-runtime.ts";
import { openFileSessionStore } from "../../shared/session/file-session-store.ts";
import { createPlanSessionSurface } from "./plan-session-surface.ts";
import { discardWorktreeGitArtifacts } from "../../shared/worktree.js";
import { addEntry, findById, removeEntry, updateEntry } from "../../shared/worktree-registry.js";
import { setCustomSetting } from "../../shared/settings.js";
import { executePlanAction, loadPlanActionEvidence } from "../../shared/workflow/plan-actions.ts";
import { recordPlanEvent } from "../../shared/workflow/plan-lifecycle.js";
import { writeControllerState } from "../../shared/workflow/controller-registry.ts";
import { defineCommittedGitFixture } from "../../shared/git-test-fixture.ts";
import { resolveProjectRuntimeLayout } from "../../shared/project-runtime-layout.ts";
import { createTestWorktreeAttempt } from "../../shared/worktree-test-helpers.ts";
import { withRuntimeCommandFixture } from "../testing/runtime-command-fixture.ts";
import { runLoadPlanCommand } from "./index.ts";
import { getLoadPlanCompletions } from "./getArgumentCompletions.ts";
import { getRunWieldRuntimeDir } from "../../constants.js";
import type { PlanFrontMatterInput } from "../../plan-store.js";
import type { EditorAPI, SelectOption, UiAPI } from "../../ui/tui/types.js";

interface LoadPlanUiFixture {
    editor: EditorAPI;
    messages: string[];
    promptOptions: SelectOption[][];
    prompts: string[];
    uiAPI: UiAPI;
}

const recoverableArchiveFixture = defineCommittedGitFixture({ ".gitignore": ".wld/\n" });

function makeUi(selections: Array<string | null>, textInputs: Array<string | null> = []): LoadPlanUiFixture {
    const pendingSelections = [...selections];
    const pendingTextInputs = [...textInputs];
    const messages: string[] = [];
    const promptOptions: SelectOption[][] = [];
    const prompts: string[] = [];
    const editor: EditorAPI = {
        disableSubmit: true,
        setText: () => {},
        setAutocompleteProvider: () => {},
        handleInput: () => {},
    };
    const uiAPI: UiAPI = {
        abortActivePrompt: () => {},
        appendSystemMessage: (message) => messages.push(message),
        appendAgentMessageStart: () => ({ appendText: () => {} }),
        requestRender: () => {},
        promptSelect: (title: string, options: SelectOption[]) => {
            prompts.push(title);
            promptOptions.push(options);
            const selection = pendingSelections.shift() ?? null;
            if (selection && !options.some((option) => option.value === selection)) {
                throw new Error(`Fixture selection was not offered for "${title}": ${selection}`);
            }
            return Promise.resolve(selection);
        },
        promptText: () => Promise.resolve(pendingTextInputs.shift() ?? null),
        showModelSelector: () => {},
    };
    return { editor, messages, promptOptions, prompts, uiAPI };
}

async function createRuntime(
    projectRoot: string,
    agentName = "router",
): Promise<{ runtime: SessionRuntime; sessionId: string }> {
    const runtime = createSessionRuntime();
    const sessionId = await runtime.createPromptReadySession({ cwd: projectRoot, agentName });
    return { runtime, sessionId };
}

async function writePlan(
    projectRoot: string,
    planName: string,
    attrs: PlanFrontMatterInput,
    body = `# ${planName}`,
): Promise<void> {
    await savePlan(projectRoot, planName, body, {
        classification: "PLANNED_CHANGE",
        complexity: "LOW",
        summary: `Fixture ${planName}`,
        affectedPaths: [],
        ...attrs,
    });
}

async function git(projectRoot: string, args: string[]): Promise<string> {
    const result = await new Deno.Command("git", {
        cwd: projectRoot,
        args,
        stdout: "piped",
        stderr: "piped",
    }).output();
    if (!result.success) throw new Error(new TextDecoder().decode(result.stderr));
    return new TextDecoder().decode(result.stdout).trim();
}

async function prepareImplementedFollowUpPlan(
    projectRoot: string,
    executionAgent = "engineer",
): Promise<{ planName: string; worktreePath: string; worktreeBranch: string }> {
    await git(projectRoot, ["init", "-b", "main"]);
    await git(projectRoot, ["config", "user.email", "tests@example.com"]);
    await git(projectRoot, ["config", "user.name", "RunWield Tests"]);
    await writePlan(projectRoot, "follow-up", {
        status: "implemented",
        executionAgent,
        executionMode: "worktree",
        planId: "follow-up-plan",
    });
    await git(projectRoot, ["add", "."]);
    await git(projectRoot, ["commit", "-m", "fixture baseline"]);
    const baselineTree = await git(projectRoot, ["rev-parse", "HEAD^{tree}"]);
    const baseCommit = await git(projectRoot, ["rev-parse", "HEAD"]);
    const worktreePath = `${projectRoot}-follow-up-worktree`;
    const branch = `rw/follow-up-${executionAgent}`;
    await git(projectRoot, ["worktree", "add", "-b", branch, worktreePath, "HEAD"]);
    const plan = await loadPlan(projectRoot, "follow-up");
    if (!plan) throw new Error("follow-up Plan fixture disappeared");
    await updatePlanFrontMatter(
        projectRoot,
        "follow-up",
        {
            executionBaselineTree: baselineTree,
            worktreeId: "follow-up-worktree",
            worktreePath,
            worktreeBranch: branch,
            worktreeBaseBranch: "main",
            worktreeStatus: "completed",
        },
        plan.attrs,
        { expectedRevision: plan.revision },
    );
    await addEntry(projectRoot, {
        id: "follow-up-worktree",
        planName: "follow-up",
        planId: "follow-up-plan",
        path: worktreePath,
        branch,
        baseBranch: "main",
        baseRef: "main",
        baseCommit,
        baseTree: baselineTree,
        executionBaselineTree: baselineTree,
        status: "completed",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
    });
    return { planName: "follow-up", worktreePath, worktreeBranch: branch };
}

async function prepareValidatedPublicationPlan(
    projectRoot: string,
    planName = "published-session-context",
    attrs: PlanFrontMatterInput = {},
    beforeBaselineCommit?: () => Promise<void>,
): Promise<{ planName: string; worktreePath: string; worktreeBranch: string; worktreeId: string }> {
    await git(projectRoot, ["init", "-b", "main"]);
    await git(projectRoot, ["config", "user.email", "tests@example.com"]);
    await git(projectRoot, ["config", "user.name", "RunWield Tests"]);
    await writePlan(projectRoot, planName, {
        status: "reviewed",
        executionAgent: "engineer",
        executionMode: "worktree",
        humanReviewMode: "none",
        planId: `${planName}-plan`,
        ...attrs,
    });
    await beforeBaselineCommit?.();
    await git(projectRoot, ["add", "."]);
    await git(projectRoot, ["commit", "-m", "fixture baseline"]);
    const baselineTree = await git(projectRoot, ["rev-parse", "HEAD^{tree}"]);
    const worktree = await createTestWorktreeAttempt({
        projectRoot,
        planName,
        planId: `${planName}-plan`,
        attemptId: `${planName.replaceAll("/", "-")}-attempt`,
    });
    const worktreePlan = await loadPlan(worktree.path, planName);
    if (!worktreePlan) throw new Error("worktree Plan fixture disappeared");
    await savePlan(worktree.path, planName, worktreePlan.markdown || worktreePlan.body || `# ${planName}`, {
        ...worktreePlan.attrs,
        status: "reviewed",
        executionAgent: "engineer",
        executionMode: "worktree",
        humanReviewMode: "none",
        planId: `${planName}-plan`,
        executionBaselineTree: baselineTree,
        worktreeId: worktree.id,
        worktreePath: worktree.path,
        worktreeBranch: worktree.branch,
        worktreeBaseBranch: "main",
        ...attrs,
    }, { expectedRevision: worktreePlan.revision });
    await Deno.writeTextFile(`${worktree.path}/published-marker.txt`, "from worktree\n");
    return { planName, worktreePath: worktree.path, worktreeBranch: worktree.branch, worktreeId: worktree.id };
}

async function captureLogs(run: () => Promise<void>): Promise<string[]> {
    const originalLog = console.log;
    const logs: string[] = [];
    console.log = (message = "") => logs.push(String(message));
    try {
        await run();
    } finally {
        console.log = originalLog;
    }
    return logs;
}

async function pathExists(path: string): Promise<boolean> {
    try {
        await Deno.stat(path);
        return true;
    } catch (error) {
        if (error instanceof Deno.errors.NotFound) return false;
        throw error;
    }
}

async function assertImplementedFollowUpRebindsFromAgent(initialAgentName: string): Promise<void> {
    await withRuntimeCommandFixture(
        `runwield-load-plan-follow-up-${initialAgentName}-`,
        async ({ projectRoot, setModelResponseFactory }) => {
            const fixture = await prepareImplementedFollowUpPlan(projectRoot);
            const { runtime, sessionId } = await createRuntime(projectRoot, initialAgentName);
            const ui = makeUi(["follow_up"]);
            let replacementId = "";
            const unsubscribe = runtime.subscribeSessionEvents(sessionId, (event) => {
                if (event.type === "session_replaced") replacementId = event.newSessionId;
            });
            let modelCalls = 0;
            let systemPrompt = "";
            setModelResponseFactory((context: TranscriptContext) => {
                modelCalls++;
                systemPrompt = getCurrentSystemPrompt(context.messages);
                return fauxAssistantMessage(fauxText("Follow-up response."));
            });
            try {
                await runLoadPlanCommand([fixture.planName], {
                    sessionRuntime: runtime,
                    sessionId,
                    uiAPI: ui.uiAPI,
                    editor: ui.editor,
                });

                const rebound = runtime.getSessionSnapshot(sessionId);
                assertEquals(replacementId, sessionId);
                assertEquals(rebound?.activeAgent, "plan-engineer");
                assertEquals(rebound?.activeExecutionWorkflow?.planName, fixture.planName);
                assertEquals(rebound?.activeExecutionWorkflow?.executionAgent, "engineer");
                assertEquals(rebound?.activeExecutionWorkflow?.executionCwd, fixture.worktreePath);
                assertEquals(modelCalls, 0);

                await runtime.promptSession(sessionId, { initialRequest: "Review the implemented change." });
                const afterTurn = runtime.getSessionSnapshot(sessionId);
                assertEquals(afterTurn?.activeExecutionWorkflow?.executionCwd, fixture.worktreePath);
                assertEquals(modelCalls, 1);
                assertStringIncludes(systemPrompt, "You are the Plan Engineer");
            } finally {
                unsubscribe();
                runtime.closeAllSessions();
            }
        },
    );
}

Deno.test("load-plan rebinds an implemented Plan follow-up from Router to its execution Agent and worktree", async () => {
    await assertImplementedFollowUpRebindsFromAgent("router");
});

Deno.test("load-plan rebinds an implemented Plan follow-up from Planner to its execution Agent and worktree", async () => {
    await assertImplementedFollowUpRebindsFromAgent("planner");
});

Deno.test("load-plan follow-up replaces the TUI Session with one rooted in the execution worktree", async () => {
    await withRuntimeCommandFixture(
        "runwield-load-plan-follow-up-replacement-",
        async ({ projectRoot, setModelResponseFactory }) => {
            const fixture = await prepareImplementedFollowUpPlan(projectRoot);
            const { runtime, sessionId } = await createRuntime(projectRoot, "planner");
            const ui = makeUi(["follow_up"]);
            let replacementId = "";
            const unsubscribe = runtime.subscribeSessionEvents(sessionId, (event) => {
                if (event.type === "session_replaced") replacementId = event.newSessionId;
            });
            let systemPrompt = "";
            setModelResponseFactory((context: TranscriptContext) => {
                systemPrompt = getCurrentSystemPrompt(context.messages);
                return fauxAssistantMessage(fauxText("Follow-up response."));
            });
            try {
                await runLoadPlanCommand([fixture.planName], {
                    sessionRuntime: runtime,
                    sessionId,
                    uiAPI: ui.uiAPI,
                    editor: ui.editor,
                });

                const replacement = runtime.getSessionSnapshot(sessionId);
                assertEquals(replacementId, sessionId);
                assertEquals(replacement?.cwd, fixture.worktreePath);
                assertEquals(replacement?.activeAgent, "plan-engineer");
                assertEquals(replacement?.activeExecutionWorkflow?.executionCwd, fixture.worktreePath);
                assertEquals(await git(fixture.worktreePath, ["branch", "--show-current"]), fixture.worktreeBranch);

                await runtime.promptSession(sessionId, { initialRequest: "Review the implemented change." });
                const afterTurn = runtime.getSessionSnapshot(sessionId);
                assertEquals(afterTurn?.cwd, fixture.worktreePath);
                assertEquals(afterTurn?.activeExecutionWorkflow?.executionCwd, fixture.worktreePath);
                assertStringIncludes(systemPrompt, "You are the Plan Engineer");
            } finally {
                unsubscribe();
                runtime.closeAllSessions();
            }
        },
    );
});

Deno.test("load-plan prints its real command help", async () => {
    const logs = await captureLogs(() => runLoadPlanCommand(["--help"]));

    assertStringIncludes(logs.join("\n"), "load-plan");
});

Deno.test("sibling dependency resolution reads canonical child Plans from the fixture catalogue", async () => {
    await withRuntimeCommandFixture("runwield-load-plan-command-", async ({ projectRoot }) => {
        await writePlan(projectRoot, "epic", { classification: "PROJECT", status: "ready_for_work" });
        await writePlan(projectRoot, "epic/01-first", { status: "verified", parentPlan: "epic" });
        await writePlan(projectRoot, "epic/02-second", { status: "implemented", parentPlan: "epic" });

        const dependencies = await resolveSiblingChildPlanDependencies(projectRoot, "epic", [
            "01-first",
            "epic/02-second",
            "03-missing",
        ]);

        assertEquals(
            dependencies.map(({ dependency, planName, status, state }) => ({ dependency, planName, status, state })),
            [
                { dependency: "01-first", planName: "epic/01-first", status: "verified", state: "verified" },
                {
                    dependency: "epic/02-second",
                    planName: "epic/02-second",
                    status: "implemented",
                    state: "unverified",
                },
                { dependency: "03-missing", planName: undefined, status: undefined, state: "missing" },
            ],
        );
    });
});

Deno.test("load-plan discovers real top-level Plans and leaves child Plans out of the picker", async () => {
    await withRuntimeCommandFixture("runwield-load-plan-command-", async ({ projectRoot }) => {
        await writePlan(projectRoot, "epic", { classification: "PROJECT", status: "draft" });
        await writePlan(projectRoot, "epic/child", { parentPlan: "epic", status: "draft" });
        const { runtime, sessionId } = await createRuntime(projectRoot);
        const ui = makeUi(["epic", "cancel"]);
        try {
            await runLoadPlanCommand([], {
                sessionRuntime: runtime,
                sessionId,
                uiAPI: ui.uiAPI,
                editor: ui.editor,
            });

            assertEquals(ui.prompts[0], "Load plan:");
            assertStringIncludes(ui.messages.join("\n"), "Plan loaded: epic");
            assertEquals(ui.messages.join("\n").includes("Plan loaded: epic/child"), false);
        } finally {
            runtime.closeAllSessions();
        }
    });
});

Deno.test("load-plan reports an empty real Plan catalogue without touching the checkout", async () => {
    await withRuntimeCommandFixture("runwield-load-plan-command-", async ({ projectRoot }) => {
        const { runtime, sessionId } = await createRuntime(projectRoot);
        const ui = makeUi([]);
        try {
            await runLoadPlanCommand([], {
                sessionRuntime: runtime,
                sessionId,
                uiAPI: ui.uiAPI,
                editor: ui.editor,
            });

            assertEquals(ui.messages, ["No plans available, start one by entering a new request"]);
            assertEquals(ui.editor.disableSubmit, false);
        } finally {
            runtime.closeAllSessions();
        }
    });
});

async function snapshotPickerFiles(root: string): Promise<Record<string, string>> {
    const result: Record<string, string> = {};
    async function visit(path: string, relativePath: string) {
        for await (const entry of Deno.readDir(path)) {
            const child = join(path, entry.name);
            const key = `${relativePath}/${entry.name}`;
            if (entry.isDirectory) {
                result[key] = "directory";
                await visit(child, key);
            } else if (entry.isSymlink) {
                result[key] = `symlink:${await Deno.readLink(child)}`;
            } else {
                result[key] = Array.from(await Deno.readFile(child)).join(",");
            }
        }
    }
    await visit(root, "");
    return result;
}

for (const runtimeState of ["absent", "legacy", "mixed"] as const) {
    Deno.test(`load-plan picker is read-only with ${runtimeState} runtime state`, async () => {
        await withRuntimeCommandFixture("runwield-picker-read-only-", async ({ projectRoot, homeDir }) => {
            // Seed documents as a user would. No store call may pre-migrate this fixture.
            await Deno.mkdir(join(projectRoot, "docs/plans/epic"), { recursive: true });
            await Deno.writeTextFile(
                join(projectRoot, "docs/plans/epic.md"),
                "---\nclassification: PROJECT\nstatus: ready_for_work\n---\n# Epic\n",
            );
            await Deno.writeTextFile(
                join(projectRoot, "docs/plans/epic/child.md"),
                "---\nparentPlan: epic\nstatus: in_progress\n---\n# Child\n",
            );
            await Deno.writeTextFile(join(projectRoot, "docs/plans/external.md"), "# External draft\n");
            const { runtime, sessionId } = await createRuntime(projectRoot);
            const runtimeRoot = getRunWieldRuntimeDir(projectRoot);
            if (runtimeState !== "absent") {
                await Deno.mkdir(join(runtimeRoot, "controller/plans"), { recursive: true });
                await Deno.writeTextFile(join(runtimeRoot, "controller/plans/old.json"), "legacy controller\n");
                await Deno.mkdir(join(runtimeRoot, "plan-transitions"), { recursive: true });
                await Deno.writeTextFile(join(runtimeRoot, "plan-transitions/unfinished.json"), "unfinished\n");
            }
            if (runtimeState === "mixed") {
                await Deno.mkdir(join(runtimeRoot, "internal/controller/plans"), { recursive: true });
                await Deno.writeTextFile(
                    join(runtimeRoot, "internal/controller/plans/new.json"),
                    "current controller\n",
                );
            }
            const beforeProject = await snapshotPickerFiles(projectRoot);
            const beforeHome = await snapshotPickerFiles(homeDir);
            const beforeSession = runtime.getSessionSnapshot(sessionId);
            const ui = makeUi([null]);
            try {
                // Completion is also browsing, before any Plan is selected.
                Deno.chdir(projectRoot);
                assertEquals((await getLoadPlanCompletions("ext")).map((item) => item.value), ["external"]);
                await runLoadPlanCommand([], {
                    sessionRuntime: runtime,
                    sessionId,
                    uiAPI: ui.uiAPI,
                    editor: ui.editor,
                });
                assertEquals(ui.prompts, ["Load plan:"]);
                assertEquals(ui.promptOptions[0].map((option) => option.value).sort(), ["epic", "external"]);
                assertEquals(ui.messages, []);
                assertEquals(await snapshotPickerFiles(projectRoot), beforeProject);
                assertEquals(await snapshotPickerFiles(homeDir), beforeHome);
                assertEquals(runtime.getSessionSnapshot(sessionId), beforeSession);
            } finally {
                runtime.closeAllSessions();
            }
        });
    });
}

Deno.test("load-plan picker leaves a registered Git worktree and recreated legacy records untouched", async () => {
    await withRuntimeCommandFixture("runwield-picker-worktree-", async ({ homeDir }) => {
        const projectRoot = await recoverableArchiveFixture.checkout({ prefix: "runwield-picker-git-" });
        let worktreePath = "";
        try {
            await writePlan(projectRoot, "unfinished", { status: "in_progress", planId: "unfinished-plan" });
            await git(projectRoot, ["add", "docs/plans"]);
            await git(projectRoot, ["commit", "-m", "Plan fixture"]);
            const attempt = await createTestWorktreeAttempt({
                projectRoot,
                planName: "unfinished",
                planId: "unfinished-plan",
                attemptId: "picker-attempt",
            });
            worktreePath = attempt.path;
            const { runtime, sessionId } = await createRuntime(projectRoot);
            // An old writer recreates records after the project was migrated.
            const primaryLegacy = getRunWieldRuntimeDir(projectRoot);
            const selectedLegacy = getRunWieldRuntimeDir(worktreePath);
            await Deno.mkdir(join(primaryLegacy, "controller/plans"), { recursive: true });
            await Deno.writeTextFile(join(primaryLegacy, "controller/plans/unfinished.json"), "old writer\n");
            await Deno.mkdir(join(selectedLegacy, "plan-locks"), { recursive: true });
            await Deno.mkdir(join(selectedLegacy, "plan-transitions"), { recursive: true });
            await Deno.writeTextFile(
                join(selectedLegacy, "plan-transitions/unfinished.json"),
                "unfinished transition\n",
            );
            const beforeProject = await snapshotPickerFiles(projectRoot);
            const beforeWorktree = await snapshotPickerFiles(worktreePath);
            const beforeHome = await snapshotPickerFiles(homeDir);
            const ui = makeUi([null]);
            try {
                await runLoadPlanCommand([], {
                    sessionRuntime: runtime,
                    sessionId,
                    uiAPI: ui.uiAPI,
                    editor: ui.editor,
                });
                assertEquals(ui.prompts, ["Load plan:"]);
                assertEquals(ui.promptOptions[0].map((option) => option.value), ["unfinished"]);
                assertEquals(ui.messages, []);
                assertEquals(await snapshotPickerFiles(projectRoot), beforeProject);
                assertEquals(await snapshotPickerFiles(worktreePath), beforeWorktree);
                assertEquals(await snapshotPickerFiles(homeDir), beforeHome);
            } finally {
                runtime.closeAllSessions();
            }
        } finally {
            if (worktreePath) await git(projectRoot, ["worktree", "remove", "--force", worktreePath]);
            await Deno.remove(projectRoot, { recursive: true });
        }
    });
});

Deno.test("load-plan archives a verified Plan through the real Plan store", async () => {
    await withRuntimeCommandFixture("runwield-load-plan-command-", async ({ projectRoot }) => {
        await writePlan(projectRoot, "finished", { status: "verified" });
        const { runtime, sessionId } = await createRuntime(projectRoot);
        const ui = makeUi(["archive"]);
        try {
            await runLoadPlanCommand(["finished"], {
                sessionRuntime: runtime,
                sessionId,
                uiAPI: ui.uiAPI,
                editor: ui.editor,
            });

            assertEquals(await loadPlan(projectRoot, "finished"), null);
            assertEquals((await loadArchivedPlan(projectRoot, "finished"))?.attrs.archivedFromStatus, "verified");
            assertStringIncludes(ui.messages.join("\n"), "Archived finished");
        } finally {
            runtime.closeAllSessions();
        }
    });
});

Deno.test("load-plan offers lifecycle actions for a validated Plan already published to its target branch", async () => {
    await withRuntimeCommandFixture("runwield-load-plan-command-", async ({ projectRoot }) => {
        await git(projectRoot, ["init", "-b", "main"]);
        await git(projectRoot, ["config", "user.email", "tests@example.com"]);
        await git(projectRoot, ["config", "user.name", "RunWield Tests"]);
        await git(projectRoot, ["commit", "--allow-empty", "-m", "fixture baseline"]);
        const executionCommit = await git(projectRoot, ["rev-parse", "HEAD"]);
        await writePlan(projectRoot, "published", {
            planId: "published-plan",
            status: "validated",
            targetBranch: "main",
            executionMode: "worktree",
            deliveryEvidence: {
                version: 1,
                mode: "worktree_merge",
                executionCommit,
                targetBranch: "main",
                targetHeadBeforeMerge: executionCommit,
            },
        });
        await git(projectRoot, ["add", "docs/plans/published.md"]);
        await git(projectRoot, ["commit", "-m", "Publish validated Plan"]);
        // Completed Plans must remain usable after all controller bookkeeping is lost.
        await Deno.remove(join(resolveProjectRuntimeLayout(projectRoot).primary.internalRoot, "controller"), {
            recursive: true,
        });
        const { runtime, sessionId } = await createRuntime(projectRoot);
        const ui = makeUi(["archive"]);
        try {
            await runLoadPlanCommand(["published"], {
                sessionRuntime: runtime,
                sessionId,
                uiAPI: ui.uiAPI,
                editor: ui.editor,
            });

            assertEquals(ui.prompts.includes("What would you like to do?"), true);
            assertEquals(await loadPlan(projectRoot, "published"), null);
            assertEquals((await loadArchivedPlan(projectRoot, "published"))?.attrs.archivedFromStatus, "verified");
        } finally {
            runtime.closeAllSessions();
        }
    });
});

Deno.test("load-plan offers completed actions for a validated non-Git Plan without controller state", async () => {
    await withRuntimeCommandFixture("runwield-load-plan-non-git-completed-", async ({ projectRoot }) => {
        await writePlan(projectRoot, "finished", { status: "validated" });
        await Deno.remove(join(resolveProjectRuntimeLayout(projectRoot).primary.internalRoot, "controller"), {
            recursive: true,
        }).catch((error) => {
            if (!(error instanceof Deno.errors.NotFound)) throw error;
        });
        const { runtime, sessionId } = await createRuntime(projectRoot);
        const ui = makeUi(["archive"]);
        try {
            await runLoadPlanCommand(["finished"], {
                sessionRuntime: runtime,
                sessionId,
                uiAPI: ui.uiAPI,
                editor: ui.editor,
            });
            assertEquals(ui.prompts.some((prompt) => prompt.startsWith("Plan recovery")), false);
            assertEquals((await loadArchivedPlan(projectRoot, "finished"))?.attrs.archivedFromStatus, "verified");
        } finally {
            runtime.closeAllSessions();
        }
    });
});

Deno.test("load-plan resumes publication, removes the worktree, and leaves Engineer in the primary checkout", async () => {
    await withRuntimeCommandFixture(
        "runwield-load-plan-published-session-",
        async ({ projectRoot, setModelResponseFactories }) => {
            const fixture = await prepareValidatedPublicationPlan(projectRoot);
            const { runtime, sessionId } = await createRuntime(fixture.worktreePath, "planner");
            const canonicalProjectRoot = await Deno.realPath(projectRoot);
            const unsubscribe = runtime.subscribeSessionEvents(sessionId, () => {});
            setModelResponseFactories([
                () => fauxAssistantMessage(fauxText("Warm turn reply.")),
                () =>
                    fauxAssistantMessage(fauxToolCall("bash", {
                        command: "pwd && git branch --show-current && cat published-marker.txt",
                    })),
                () => fauxAssistantMessage(fauxText("Shell checked.")),
            ]);
            const ui = makeUi(["validate"]);
            try {
                await runtime.promptSession(sessionId, { initialRequest: "Warm the root Agent." });
                await runLoadPlanCommand([fixture.planName], {
                    sessionRuntime: runtime,
                    sessionId,
                    uiAPI: ui.uiAPI,
                    editor: ui.editor,
                });

                const snapshot = runtime.getSessionSnapshot(sessionId);
                assertEquals(await pathExists(fixture.worktreePath), false);
                assertEquals(await findById(projectRoot, fixture.worktreeId), null);
                assertEquals(snapshot?.activeAgent, "engineer");
                assertEquals(snapshot?.cwd, canonicalProjectRoot);
                assertEquals(snapshot?.activeExecutionWorkflow, null);

                const shell = await new Deno.Command("sh", {
                    cwd: canonicalProjectRoot,
                    args: ["-c", "pwd && git branch --show-current && cat published-marker.txt"],
                    stdout: "piped",
                    stderr: "piped",
                }).output();
                assertEquals(shell.success, true, new TextDecoder().decode(shell.stderr));
                const shellOutput = new TextDecoder().decode(shell.stdout);
                assertStringIncludes(shellOutput, canonicalProjectRoot);
                assertStringIncludes(shellOutput, "main");
                assertStringIncludes(shellOutput, "from worktree");
            } finally {
                unsubscribe();
                runtime.closeAllSessions();
            }
        },
    );
});

for (const confirmRemoval of [true, false]) {
    Deno.test(`User Verification carries the Plan to primary and ${confirmRemoval ? "removes" : "preserves"} the worktree after confirmation`, async () => {
        await withRuntimeCommandFixture("runwield-user-verification-authority-", async ({ projectRoot }) => {
            const fixture = await prepareImplementedFollowUpPlan(projectRoot);
            await updateEntry(projectRoot, "follow-up-worktree", { status: "active" });
            await setCustomSetting("workRecords", { autoGenerateOnPlanCompletion: false }, "project", projectRoot);
            const execution = await loadPlan(fixture.worktreePath, fixture.planName);
            if (!execution) throw new Error("Missing execution Plan");
            await Deno.writeTextFile(execution.path, execution.markdown + "\nExecution-only completion notes.\n");
            const { runtime, sessionId } = await createRuntime(projectRoot);
            await runtime.switchAgent(sessionId, { agentName: "planner" });
            await runtime.switchAgent(sessionId, { agentName: "engineer", cwd: fixture.worktreePath });
            await runtime.setActiveExecutionWorkflow(sessionId, {
                planName: fixture.planName,
                projectRoot,
                triageMeta: execution.attrs,
                executionAgent: "engineer",
                executionMode: "worktree",
                executionCwd: fixture.worktreePath,
            });
            try {
                const verify = makeUi(["user_verify", confirmRemoval ? "confirm" : "cancel"], [
                    "Shipped through the release PR.",
                ]);
                await runLoadPlanCommand([fixture.planName], {
                    sessionRuntime: runtime,
                    sessionId,
                    uiAPI: verify.uiAPI,
                    editor: verify.editor,
                });
                const accepted = await loadPlan(projectRoot, fixture.planName);
                assertEquals(accepted?.attrs.status, "user_verified");
                assertEquals(accepted?.attrs.userVerificationNote, "Shipped through the release PR.");
                assertEquals(accepted?.attrs.verifiedAt, undefined);
                assertEquals(accepted?.attrs.deliveryEvidence, undefined);
                assertStringIncludes(accepted?.body || "", "Execution-only completion notes.");
                assertEquals(await pathExists(fixture.worktreePath), !confirmRemoval);
                assertEquals(
                    (await findById(projectRoot, "follow-up-worktree"))?.status,
                    confirmRemoval ? undefined : "abandoned",
                );
                assertEquals(runtime.getSessionSnapshot(sessionId)?.cwd, await Deno.realPath(projectRoot));
                assertEquals(accepted?.attrs.documentWorktreeId, undefined);
                assertEquals(accepted?.attrs.executionMode, undefined);

                const reload = makeUi(confirmRemoval ? ["archive"] : ["archive", "cancel", "archive", "confirm"]);
                await runLoadPlanCommand([fixture.planName], {
                    sessionRuntime: runtime,
                    sessionId,
                    uiAPI: reload.uiAPI,
                    editor: reload.editor,
                });
                assertEquals(reload.promptOptions[0].map((option) => option.value), [
                    "archive",
                    "review",
                    "view",
                    "cancel",
                ]);
                assertEquals(reload.prompts.some((prompt) => prompt.startsWith("Plan recovery")), false);
                assertEquals(
                    (await loadArchivedPlan(projectRoot, fixture.planName))?.attrs.archivedFromStatus,
                    "user_verified",
                );
                assertEquals(await pathExists(fixture.worktreePath), false);
                assertEquals(await findById(projectRoot, "follow-up-worktree"), null);
            } finally {
                runtime.closeAllSessions();
                await git(projectRoot, ["worktree", "remove", "--force", fixture.worktreePath]).catch(() => {});
            }
        });
    });
}

Deno.test("load-plan confirms cleanup of unregistered legacy recovery when archiving a User Verified Plan", async () => {
    await withRuntimeCommandFixture("runwield-load-plan-command-", async ({ projectRoot }) => {
        await git(projectRoot, ["init", "-b", "main"]);
        await git(projectRoot, ["config", "user.email", "tests@example.com"]);
        await git(projectRoot, ["config", "user.name", "RunWield Tests"]);
        await git(projectRoot, ["commit", "--allow-empty", "-m", "recovery fixture"]);
        const lostPath = `${projectRoot}/lost-worktree`;
        await writePlan(projectRoot, "finished-with-stale-worktree", {
            planId: "lost-plan",
            status: "user_verified",
            executionMode: "worktree",
            worktreeStatus: "validation_failed",
            worktreeId: "lost-worktree",
            worktreePath: lostPath,
            worktreeBranch: "worktree/lost-worktree",
            worktreeBaseBranch: "main",
        });
        await writeControllerState(
            projectRoot,
            { planId: "lost-plan", planName: "finished-with-stale-worktree" },
            {},
            {
                recovery: {
                    worktreeId: "lost-worktree",
                    worktreePath: lostPath,
                    worktreeBranch: "worktree/lost-worktree",
                    worktreeBaseBranch: "main",
                    worktreeStatus: "validation_failed",
                },
            },
        );
        assertEquals(await findById(projectRoot, "lost-worktree"), null);
        const { runtime, sessionId } = await createRuntime(projectRoot);
        const ui = makeUi(["archive", "confirm"]);
        try {
            await runLoadPlanCommand(["finished-with-stale-worktree"], {
                sessionRuntime: runtime,
                sessionId,
                uiAPI: ui.uiAPI,
                editor: ui.editor,
            });

            assertEquals(await loadPlan(projectRoot, "finished-with-stale-worktree"), null);
            const archived = await loadArchivedPlan(projectRoot, "finished-with-stale-worktree");
            assertEquals(archived?.attrs.archivedFromStatus, "user_verified");
            assertEquals(archived?.attrs.worktreeStatus, undefined, "unregistered recovery hints remain cleared");
            assertEquals(archived?.attrs.worktreeId, undefined);
            assertEquals(archived?.attrs.worktreePath, undefined);
            const archivedDocument = parsePlanFrontMatter(archived?.markdown || "").attrs;
            assertEquals(archivedDocument.worktreeStatus, undefined, "archives do not contain runtime state");
            assertEquals(archivedDocument.worktreeId, undefined);
            assertStringIncludes(ui.messages.join("\n"), "Archived finished-with-stale-worktree");
        } finally {
            runtime.closeAllSessions();
        }
    });
});

Deno.test("load-plan archives a verified Epic with every child Plan and keeps the folder structure", async () => {
    await withRuntimeCommandFixture("runwield-load-plan-command-", async ({ projectRoot }) => {
        await writePlan(projectRoot, "epic", { classification: "PROJECT", status: "verified" });
        await writePlan(projectRoot, "epic/01-first", { status: "verified", parentPlan: "epic", order: 1 });
        await writePlan(projectRoot, "epic/02-second", { status: "ready_for_work", parentPlan: "epic", order: 2 });
        const { runtime, sessionId } = await createRuntime(projectRoot);
        const ui = makeUi(["archive_epic", "confirm"]);
        try {
            await runLoadPlanCommand(["epic"], {
                sessionRuntime: runtime,
                sessionId,
                uiAPI: ui.uiAPI,
                editor: ui.editor,
            });

            assertEquals(await loadPlan(projectRoot, "epic"), null);
            assertEquals(await loadPlan(projectRoot, "epic/01-first"), null);
            assertEquals(await loadPlan(projectRoot, "epic/02-second"), null);
            assertEquals((await loadArchivedPlan(projectRoot, "epic"))?.attrs.archivedFromStatus, "verified");
            assertEquals((await loadArchivedPlan(projectRoot, "epic/01-first"))?.attrs.archivedFromStatus, "verified");
            assertEquals(
                (await loadArchivedPlan(projectRoot, "epic/02-second"))?.attrs.archivedFromStatus,
                "ready_for_work",
            );
            await Deno.stat(`${projectRoot}/docs/plans/archived/epic.md`);
            await Deno.stat(`${projectRoot}/docs/plans/archived/epic/01-first.md`);
            await Deno.stat(`${projectRoot}/docs/plans/archived/epic/02-second.md`);
            assertEquals(await pathExists(`${projectRoot}/docs/plans/epic`), false);
        } finally {
            runtime.closeAllSessions();
        }
    });
});

Deno.test("load-plan refuses to archive an Epic whose child has a recoverable worktree", async () => {
    await withRuntimeCommandFixture("runwield-load-plan-command-", async () => {
        const projectRoot = await recoverableArchiveFixture.checkout();
        await writePlan(projectRoot, "epic", { classification: "PROJECT", status: "verified" });
        await writePlan(projectRoot, "epic/child", {
            planId: "active-child",
            status: "ready_for_work",
            parentPlan: "epic",
            worktreeStatus: "active",
        });
        await git(projectRoot, ["add", "docs"]);
        await git(projectRoot, ["commit", "-m", "Epic with recoverable child"]);
        const worktreePath = `${projectRoot}-child`;
        await git(projectRoot, ["worktree", "add", "-b", "worktree/child", worktreePath]);
        await addEntry(projectRoot, {
            id: "child-attempt",
            planId: "active-child",
            planName: "epic/child",
            path: worktreePath,
            branch: "worktree/child",
            baseBranch: "main",
            baseRef: "main",
            baseCommit: await git(projectRoot, ["rev-parse", "HEAD"]),
            baseTree: await git(projectRoot, ["rev-parse", "HEAD^{tree}"]),
            status: "active",
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
        });
        const { runtime, sessionId } = await createRuntime(projectRoot);
        const ui = makeUi(["archive_epic", "cancel"]);
        try {
            await runLoadPlanCommand(["epic"], {
                sessionRuntime: runtime,
                sessionId,
                uiAPI: ui.uiAPI,
                editor: ui.editor,
            });

            assertEquals((await loadPlan(projectRoot, "epic"))?.attrs.status, "verified");
            assertEquals((await loadPlan(projectRoot, "epic/child"))?.attrs.worktreeStatus, "active");
            assertEquals(await loadArchivedPlan(projectRoot, "epic"), null);
            assertEquals(await loadArchivedPlan(projectRoot, "epic/child"), null);
            assertStringIncludes(ui.messages.join("\n"), "epic/child");
            assertStringIncludes(ui.messages.join("\n"), "active");
        } finally {
            runtime.closeAllSessions();
            await git(projectRoot, ["worktree", "remove", "--force", worktreePath]).catch(() => {});
            await Deno.remove(projectRoot, { recursive: true });
        }
    });
});

Deno.test("load-plan puts a draft Plan on hold through the lifecycle transaction", async () => {
    await withRuntimeCommandFixture("runwield-load-plan-command-", async ({ projectRoot }) => {
        await writePlan(projectRoot, "paused", { status: "draft" });
        const { runtime, sessionId } = await createRuntime(projectRoot);
        const ui = makeUi(["hold"], ["Waiting for fixture input"]);
        try {
            await runLoadPlanCommand(["paused"], {
                sessionRuntime: runtime,
                sessionId,
                uiAPI: ui.uiAPI,
                editor: ui.editor,
            });

            const plan = await loadPlan(projectRoot, "paused");
            assertEquals(plan?.attrs.status, "on_hold");
            assertEquals(plan?.attrs.holdReason, "Waiting for fixture input");
        } finally {
            runtime.closeAllSessions();
        }
    });
});

Deno.test("load-plan resumes an on-hold Plan after the real non-Git Resume Check", async () => {
    await withRuntimeCommandFixture("runwield-load-plan-command-", async ({ projectRoot }) => {
        await writePlan(projectRoot, "paused", {
            status: "on_hold",
            heldFromStatus: "draft",
            holdReason: "Waiting for fixture input",
        });
        const { runtime, sessionId } = await createRuntime(projectRoot);
        const ui = makeUi(["resume", "cancel"]);
        try {
            await runLoadPlanCommand(["paused"], {
                sessionRuntime: runtime,
                sessionId,
                uiAPI: ui.uiAPI,
                editor: ui.editor,
            });

            assertEquals((await loadPlan(projectRoot, "paused"))?.attrs.status, "draft");
            assertStringIncludes(ui.messages.join("\n"), "Resumed from hold");
        } finally {
            runtime.closeAllSessions();
        }
    });
});

Deno.test("load-plan marks an Epic done enough only after the real lifecycle write", async () => {
    await withRuntimeCommandFixture("runwield-load-plan-command-", async ({ projectRoot }) => {
        await writePlan(projectRoot, "epic", { classification: "PROJECT", status: "ready_for_work" });
        await writePlan(projectRoot, "epic/child", {
            status: "ready_for_work",
            parentPlan: "epic",
            order: 1,
        });
        const { runtime, sessionId } = await createRuntime(projectRoot);
        const ui = makeUi(["done_enough", "confirm", "cancel"]);
        try {
            await runLoadPlanCommand(["epic"], {
                sessionRuntime: runtime,
                sessionId,
                uiAPI: ui.uiAPI,
                editor: ui.editor,
            });

            const epic = await loadPlan(projectRoot, "epic");
            assertEquals(epic?.attrs.status, "closed_without_verification");
            assertEquals(typeof epic?.attrs.epicDoneEnoughAt, "string");
            assertEquals((await loadPlan(projectRoot, "epic/child"))?.attrs.status, "ready_for_work");
            const reloaded = makeUi(["cancel"]);
            await runLoadPlanCommand(["epic"], {
                sessionRuntime: runtime,
                sessionId,
                uiAPI: reloaded.uiAPI,
                editor: reloaded.editor,
            });
            assertEquals(reloaded.promptOptions.flat().some((option) => option.label.includes("Pick a child")), true);
            assertEquals(ui.messages.some((message) => message.includes("status to verified")), false);
        } finally {
            runtime.closeAllSessions();
        }
    });
});

Deno.test("load-plan distinguishes validated Epic children from pending publication", async () => {
    await withRuntimeCommandFixture("runwield-epic-publication-", async ({ projectRoot }) => {
        await prepareValidatedPublicationPlan(projectRoot, "epic/child", {
            status: "validated",
            parentPlan: "epic",
            order: 1,
        }, async () => {
            await writePlan(projectRoot, "epic", {
                classification: "PROJECT",
                status: "validated",
                epicCompletionMode: "done_enough",
                epicDoneEnoughSummary: "All child plans are completed.",
            });
        });
        const { runtime, sessionId } = await createRuntime(projectRoot);
        const ui = makeUi(["publish:epic/child", "cancel"]);
        try {
            await runLoadPlanCommand(["epic"], {
                sessionRuntime: runtime,
                sessionId,
                uiAPI: ui.uiAPI,
                editor: ui.editor,
            });
            assertStringIncludes(ui.messages.join("\n"), "Publication is still pending for epic/child");
            assertEquals(ui.messages.some((message) => message.includes("All child plans are completed")), false);
            assertEquals(ui.promptOptions.flat().some((option) => option.value === "publish:epic/child"), true);
            assertStringIncludes(ui.messages.join("\n"), "Plan loaded: epic/child");
        } finally {
            runtime.closeAllSessions();
        }
    });
});

Deno.test("Approve for Later creates no execution segment", async () => {
    await withRuntimeCommandFixture("runwield-load-plan-command-", async ({ projectRoot }) => {
        await Deno.mkdir(`${projectRoot}/docs/plans`, { recursive: true });
        await Deno.writeTextFile(
            `${projectRoot}/docs/plans/reviewed.md`,
            [
                "---",
                "classification: PLANNED_CHANGE",
                "complexity: LOW",
                "summary: Reviewed",
                "affectedPaths: []",
                "status: approved",
                "---",
                "# reviewed",
                "",
            ].join("\n"),
        );
        const { runtime, sessionId } = await createRuntime(projectRoot);
        runtime.setInteractionAdapter(sessionId, {
            requestInteraction: async (request) => {
                const plan = await loadPlan(projectRoot, "reviewed");
                return {
                    outcome: "accepted",
                    _meta: {
                        approved: true,
                        approvalAction: "later",
                        revision: plan?.revision,
                        planAttrs: plan?.attrs,
                        interactionType: request.type,
                    },
                };
            },
        });
        const ui = makeUi(["review"]);
        try {
            await runLoadPlanCommand(["reviewed"], {
                sessionRuntime: runtime,
                sessionId,
                uiAPI: ui.uiAPI,
                editor: ui.editor,
            });

            assertEquals(
                (await loadPlan(projectRoot, "reviewed"))?.attrs.status,
                "ready_for_work",
                ui.messages.join("\n"),
            );
            assertEquals(runtime.getRuntimeActiveExecutionWorkflow(sessionId), null);
            assertStringIncludes(ui.messages.join("\n"), "Plan saved. Resume later");
        } finally {
            runtime.closeAllSessions();
        }
    });
});

Deno.test("direct review from draft approves for later without a planning turn", async () => {
    await withRuntimeCommandFixture("runwield-load-plan-command-", async ({ projectRoot }) => {
        await Deno.mkdir(`${projectRoot}/docs/plans`, { recursive: true });
        await Deno.writeTextFile(
            `${projectRoot}/docs/plans/direct-draft.md`,
            [
                "---",
                "classification: PLANNED_CHANGE",
                "complexity: LOW",
                "summary: Direct draft",
                "affectedPaths: []",
                "status: draft",
                "---",
                "# direct-draft",
                "",
            ].join("\n"),
        );
        const { runtime, sessionId } = await createRuntime(projectRoot);
        runtime.setInteractionAdapter(sessionId, {
            requestInteraction: async () => {
                const beforeReview = await loadPlan(projectRoot, "direct-draft");
                if (!beforeReview) throw new Error("Fixture Plan disappeared before direct review");
                assertEquals(runtime.getSessionSnapshot(sessionId)?.workflowContext?.planName, undefined);
                await recordPlanEvent({
                    cwd: projectRoot,
                    planName: "direct-draft",
                    event: "review_approved",
                    currentStatus: beforeReview.attrs.status,
                    expectedRevision: beforeReview.revision,
                    details: { triageMeta: beforeReview.attrs },
                });
                const approved = await loadPlan(projectRoot, "direct-draft");
                return {
                    outcome: "accepted",
                    _meta: {
                        approved: true,
                        approvalAction: "later",
                        revision: approved?.revision,
                        planAttrs: approved?.attrs,
                    },
                };
            },
        });
        const ui = makeUi(["review"]);
        try {
            await runLoadPlanCommand(["direct-draft"], {
                sessionRuntime: runtime,
                sessionId,
                uiAPI: ui.uiAPI,
                editor: ui.editor,
            });

            assertEquals((await loadPlan(projectRoot, "direct-draft"))?.attrs.status, "ready_for_work");
            assertEquals(runtime.getRuntimeActiveExecutionWorkflow(sessionId), null);
            assertEquals(
                ui.promptOptions[0].some((option) => option.value === "review" && option.label === "Review plan"),
                true,
            );
        } finally {
            runtime.closeAllSessions();
        }
    });
});

for (const status of ["draft", "feedback", "approved", "ready_for_work"] as const) {
    Deno.test(`direct review menu is available for ${status} without custom shell checks`, async () => {
        await withRuntimeCommandFixture("runwield-load-plan-command-", async ({ projectRoot }) => {
            await writePlan(projectRoot, "review-without-checks", { status });
            const { runtime, sessionId } = await createRuntime(projectRoot);
            const ui = makeUi(["cancel"]);
            try {
                await runLoadPlanCommand(["review-without-checks"], {
                    sessionRuntime: runtime,
                    sessionId,
                    uiAPI: ui.uiAPI,
                    editor: ui.editor,
                });

                assertEquals(ui.promptOptions[0].some((option) => option.value === "review"), true);
                const continuation = status === "draft" || status === "feedback" ? "resume" : "proceed";
                assertEquals(ui.promptOptions[0].some((option) => option.value === continuation), true);
                assertEquals((await loadPlan(projectRoot, "review-without-checks"))?.attrs.status, status);
            } finally {
                runtime.closeAllSessions();
            }
        });
    });
}

Deno.test("direct review from draft can approve and start execution", async () => {
    await withRuntimeCommandFixture("runwield-load-plan-command-", async ({ projectRoot, setModelMessages }) => {
        await Deno.mkdir(`${projectRoot}/docs/plans`, { recursive: true });
        await Deno.writeTextFile(
            `${projectRoot}/docs/plans/direct-run.md`,
            [
                "---",
                "classification: PLANNED_CHANGE",
                "complexity: LOW",
                "summary: Direct run",
                "affectedPaths: []",
                "status: draft",
                "---",
                "# direct-run",
                "",
            ].join("\n"),
        );
        setModelMessages([fauxAssistantMessage(fauxToolCall("task_completed", { message: "- direct run complete" }))]);
        const { runtime, sessionId } = await createRuntime(projectRoot);
        runtime.setInteractionAdapter(sessionId, {
            requestInteraction: async (request) => {
                if (
                    request.type === "select" && request.options?.some((option) => option.value === "proceed") === true
                ) {
                    return { outcome: "selected", value: "proceed" };
                }
                const beforeReview = await loadPlan(projectRoot, "direct-run");
                if (!beforeReview) throw new Error("Fixture Plan disappeared before direct review");
                await recordPlanEvent({
                    cwd: projectRoot,
                    planName: "direct-run",
                    event: "review_approved",
                    currentStatus: beforeReview.attrs.status,
                    expectedRevision: beforeReview.revision,
                    details: { triageMeta: beforeReview.attrs },
                });
                const approved = await loadPlan(projectRoot, "direct-run");
                return {
                    outcome: "accepted",
                    _meta: {
                        approved: true,
                        approvalAction: "run",
                        revision: approved?.revision,
                        planAttrs: approved?.attrs,
                    },
                };
            },
        });
        const ui = makeUi(["review", "proceed"]);
        try {
            await runLoadPlanCommand(["direct-run"], {
                sessionRuntime: runtime,
                sessionId,
                uiAPI: ui.uiAPI,
                editor: ui.editor,
            });

            assertEquals((await loadPlan(projectRoot, "direct-run"))?.attrs.executionMode, "non_git_in_place");
            assertEquals((await loadPlan(projectRoot, "direct-run"))?.attrs.status === "draft", false);
            assertEquals(
                ui.promptOptions[0].some((option) => option.value === "review" && option.label === "Review plan"),
                true,
            );
        } finally {
            runtime.closeAllSessions();
        }
    });
});

Deno.test("direct review from feedback can send feedback back through Planner", async () => {
    await withRuntimeCommandFixture("runwield-load-plan-command-", async ({ projectRoot, setModelMessages }) => {
        await Deno.mkdir(`${projectRoot}/docs/plans`, { recursive: true });
        await Deno.writeTextFile(
            `${projectRoot}/docs/plans/direct-feedback.md`,
            [
                "---",
                "classification: PLANNED_CHANGE",
                "complexity: LOW",
                "summary: Direct feedback",
                "affectedPaths: []",
                "status: feedback",
                "---",
                "# direct-feedback",
                "",
            ].join("\n"),
        );
        setModelMessages([
            fauxAssistantMessage(fauxToolCall("plan_written", {
                planName: "direct-feedback",
            })),
        ]);
        const { runtime, sessionId } = await createRuntime(projectRoot);
        let reviewCount = 0;
        runtime.setInteractionAdapter(sessionId, {
            requestInteraction: async () => {
                reviewCount += 1;
                const plan = await loadPlan(projectRoot, "direct-feedback");
                if (!plan) throw new Error("Fixture Plan disappeared before review");
                if (reviewCount === 1) {
                    await recordPlanEvent({
                        cwd: projectRoot,
                        planName: "direct-feedback",
                        event: "review_feedback",
                        currentStatus: plan.attrs.status,
                        expectedRevision: plan.revision,
                        details: { triageMeta: plan.attrs },
                    });
                    return {
                        outcome: "accepted",
                        _meta: {
                            approved: false,
                            feedback: "Revise the Plan directly.",
                            images: [{ base64: "aW1hZ2U=", mimeType: "image/png" }],
                        },
                    };
                }
                await recordPlanEvent({
                    cwd: projectRoot,
                    planName: "direct-feedback",
                    event: "review_approved",
                    currentStatus: plan.attrs.status,
                    expectedRevision: plan.revision,
                    details: { triageMeta: plan.attrs },
                });
                const approved = await loadPlan(projectRoot, "direct-feedback");
                return {
                    outcome: "accepted",
                    _meta: {
                        approved: true,
                        approvalAction: "later",
                        revision: approved?.revision,
                        planAttrs: approved?.attrs,
                    },
                };
            },
        });
        const ui = makeUi(["review"]);
        try {
            await runLoadPlanCommand(["direct-feedback"], {
                sessionRuntime: runtime,
                sessionId,
                uiAPI: ui.uiAPI,
                editor: ui.editor,
            });

            assertEquals(reviewCount, 2);
            assertEquals((await loadPlan(projectRoot, "direct-feedback"))?.attrs.status, "ready_for_work");
            assertEquals(runtime.getSessionSnapshot(sessionId)?.workflowContext?.planName, "direct-feedback");
        } finally {
            runtime.closeAllSessions();
        }
    });
});

Deno.test("direct review from ready_for_work reopens review and approves for later", async () => {
    await withRuntimeCommandFixture("runwield-load-plan-command-", async ({ projectRoot, setModelResponseFactory }) => {
        await Deno.mkdir(`${projectRoot}/docs/plans`, { recursive: true });
        await Deno.writeTextFile(
            `${projectRoot}/docs/plans/direct-ready.md`,
            [
                "---",
                "classification: PLANNED_CHANGE",
                "complexity: LOW",
                "summary: Direct ready",
                "affectedPaths: []",
                "status: ready_for_work",
                "---",
                "# direct-ready",
                "",
            ].join("\n"),
        );
        let modelTurns = 0;
        setModelResponseFactory(() => {
            modelTurns++;
            return fauxAssistantMessage(fauxText("Unexpected planning turn"));
        });
        const { runtime, sessionId } = await createRuntime(projectRoot);
        runtime.setInteractionAdapter(sessionId, {
            requestInteraction: async () => {
                const readyPlan = await loadPlan(projectRoot, "direct-ready");
                if (!readyPlan) throw new Error("Fixture Plan disappeared before review");
                await recordPlanEvent({
                    cwd: projectRoot,
                    planName: "direct-ready",
                    event: "review_reopened",
                    currentStatus: readyPlan.attrs.status,
                    expectedRevision: readyPlan.revision,
                    details: { triageMeta: readyPlan.attrs },
                });
                const reopenedPlan = await loadPlan(projectRoot, "direct-ready");
                if (!reopenedPlan) throw new Error("Fixture Plan disappeared after reopen");
                await recordPlanEvent({
                    cwd: projectRoot,
                    planName: "direct-ready",
                    event: "review_approved",
                    currentStatus: reopenedPlan.attrs.status,
                    expectedRevision: reopenedPlan.revision,
                    details: { triageMeta: reopenedPlan.attrs },
                });
                const approved = await loadPlan(projectRoot, "direct-ready");
                return {
                    outcome: "accepted",
                    _meta: {
                        approved: true,
                        approvalAction: "later",
                        revision: approved?.revision,
                        planAttrs: approved?.attrs,
                    },
                };
            },
        });
        const ui = makeUi(["review"]);
        try {
            await runLoadPlanCommand(["direct-ready"], {
                sessionRuntime: runtime,
                sessionId,
                uiAPI: ui.uiAPI,
                editor: ui.editor,
            });

            assertEquals((await loadPlan(projectRoot, "direct-ready"))?.attrs.status, "ready_for_work");
            assertEquals(modelTurns, 0);
            assertEquals(runtime.getRuntimeActiveExecutionWorkflow(sessionId), null);
            assertEquals(
                ui.promptOptions[0].some((option) => option.value === "review" && option.label === "Review plan"),
                true,
            );
        } finally {
            runtime.closeAllSessions();
        }
    });
});

Deno.test("direct review menu is omitted when a draft has an invalid execution policy", async () => {
    await withRuntimeCommandFixture("runwield-load-plan-command-", async ({ projectRoot }) => {
        await Deno.mkdir(`${projectRoot}/docs/plans`, { recursive: true });
        await Deno.writeTextFile(
            `${projectRoot}/docs/plans/invalid-policy-draft.md`,
            [
                "---",
                "classification: PLANNED_CHANGE",
                "complexity: LOW",
                "summary: Invalid policy draft",
                "affectedPaths: []",
                "status: draft",
                "executionAgent: architect",
                "collaborationRecommendation: autonomous",
                "---",
                "# Invalid policy draft",
                "",
            ].join("\n"),
        );
        const { runtime, sessionId } = await createRuntime(projectRoot);
        const ui = makeUi(["cancel"]);
        try {
            await runLoadPlanCommand(["invalid-policy-draft"], {
                sessionRuntime: runtime,
                sessionId,
                uiAPI: ui.uiAPI,
                editor: ui.editor,
            });

            assertEquals(ui.promptOptions[0].some((option) => option.value === "review"), false);
            assertEquals(ui.promptOptions[0].some((option) => option.value === "resume"), true);
        } finally {
            runtime.closeAllSessions();
        }
    });
});

Deno.test("direct review on a PROJECT Epic approves and slices", async () => {
    await withRuntimeCommandFixture("runwield-load-plan-command-", async ({ projectRoot, setModelMessages }) => {
        await writePlan(projectRoot, "direct-epic", { classification: "PROJECT", status: "draft" });
        setModelMessages([fauxAssistantMessage(fauxToolCall("task_completed", { message: "- sliced" }))]);
        const { runtime, sessionId } = await createRuntime(projectRoot);
        runtime.setInteractionAdapter(sessionId, {
            requestInteraction: async () => {
                const beforeReview = await loadPlan(projectRoot, "direct-epic");
                if (!beforeReview) throw new Error("Fixture Epic disappeared before direct review");
                await recordPlanEvent({
                    cwd: projectRoot,
                    planName: "direct-epic",
                    event: "review_approved",
                    currentStatus: beforeReview.attrs.status,
                    expectedRevision: beforeReview.revision,
                    details: { triageMeta: beforeReview.attrs },
                });
                const approved = await loadPlan(projectRoot, "direct-epic");
                return {
                    outcome: "accepted",
                    _meta: {
                        approved: true,
                        approvalAction: "decompose",
                        revision: approved?.revision,
                        planAttrs: approved?.attrs,
                    },
                };
            },
        });
        const ui = makeUi(["direct_review"]);
        try {
            await runLoadPlanCommand(["direct-epic"], {
                sessionRuntime: runtime,
                sessionId,
                uiAPI: ui.uiAPI,
                editor: ui.editor,
            });

            assertEquals((await loadPlan(projectRoot, "direct-epic"))?.attrs.status, "ready_for_decomposition");
            assertEquals(
                ui.promptOptions[0].some((option) =>
                    option.value === "direct_review" && option.label === "Review plan"
                ),
                true,
            );
            assertEquals(
                ui.promptOptions[0].some((option) =>
                    option.value === "review" && option.label === "Review with Architect"
                ),
                true,
            );
        } finally {
            runtime.closeAllSessions();
        }
    });
});

Deno.test("load-plan runs the real Planner and plan_written machinery against the faux model boundary", async () => {
    await withRuntimeCommandFixture(
        "runwield-load-plan-command-",
        async ({ projectRoot, setModelMessages }) => {
            await writePlan(projectRoot, "planned", { status: "draft" });
            setModelMessages([
                fauxAssistantMessage(fauxToolCall("plan_written", {
                    planName: "planned",
                })),
            ]);
            const { runtime, sessionId } = await createRuntime(projectRoot);
            runtime.setInteractionAdapter(sessionId, {
                requestInteraction: async () => {
                    const beforeReview = await loadPlan(projectRoot, "planned");
                    if (!beforeReview) throw new Error("Fixture Plan disappeared before review");
                    await recordPlanEvent({
                        cwd: projectRoot,
                        planName: "planned",
                        event: "review_approved",
                        currentStatus: beforeReview.attrs.status,
                        expectedRevision: beforeReview.revision,
                        details: { triageMeta: beforeReview.attrs },
                    });
                    const approved = await loadPlan(projectRoot, "planned");
                    return {
                        outcome: "accepted",
                        _meta: {
                            approved: true,
                            approvalAction: "later",
                            revision: approved?.revision,
                            planAttrs: approved?.attrs,
                        },
                    };
                },
            });
            const ui = makeUi(["resume"]);
            try {
                await runLoadPlanCommand(["planned"], {
                    sessionRuntime: runtime,
                    sessionId,
                    uiAPI: ui.uiAPI,
                    editor: ui.editor,
                });

                assertEquals((await loadPlan(projectRoot, "planned"))?.attrs.status, "ready_for_work");
                assertEquals(runtime.getSessionSnapshot(sessionId)?.activeAgent, "planner");
                // The resumed Planner turn records the Plan it was opened on, so a
                // compaction mid-draft still has a pointer back to the file.
                assertEquals(runtime.getSessionSnapshot(sessionId)?.workflowContext?.planName, "planned");
            } finally {
                runtime.closeAllSessions();
            }
        },
    );
});

Deno.test("load-plan uses real Git history and cancels stale affected-path execution", async () => {
    await withRuntimeCommandFixture("runwield-load-plan-command-", async ({ projectRoot }) => {
        await git(projectRoot, ["init", "-b", "main"]);
        await git(projectRoot, ["config", "user.email", "tests@example.com"]);
        await git(projectRoot, ["config", "user.name", "RunWield Tests"]);
        await Deno.writeTextFile(`${projectRoot}/app.ts`, "export const value = 1;\n");
        await writePlan(projectRoot, "stale", {
            status: "ready_for_work",
            affectedPaths: ["app.ts"],
            updatedAt: "2020-01-01T00:00:00.000Z",
        });
        await git(projectRoot, ["add", "."]);
        await git(projectRoot, ["commit", "-m", "fixture baseline"]);
        await Deno.writeTextFile(`${projectRoot}/app.ts`, "export const value = 2;\n");
        await git(projectRoot, ["add", "app.ts"]);
        await git(projectRoot, ["commit", "-m", "change affected path"]);

        const { runtime, sessionId } = await createRuntime(projectRoot);
        const ui = makeUi(["proceed", "cancel"]);
        try {
            await runLoadPlanCommand(["stale"], {
                sessionRuntime: runtime,
                sessionId,
                uiAPI: ui.uiAPI,
                editor: ui.editor,
            });

            assertEquals((await loadPlan(projectRoot, "stale"))?.attrs.status, "ready_for_work");
            assertStringIncludes(ui.messages.join("\n"), "touched affected paths");
            assertStringIncludes(ui.messages.join("\n"), "Execution canceled");
        } finally {
            runtime.closeAllSessions();
        }
    });
});

Deno.test("load-plan blocks a child Plan while its real parent Epic is on hold", async () => {
    await withRuntimeCommandFixture("runwield-load-plan-command-", async ({ projectRoot }) => {
        await writePlan(projectRoot, "epic", { classification: "PROJECT", status: "on_hold", heldFromStatus: "draft" });
        await writePlan(projectRoot, "epic/child", { status: "draft", parentPlan: "epic" });
        const { runtime, sessionId } = await createRuntime(projectRoot);
        const ui = makeUi(["cancel"]);
        try {
            await runLoadPlanCommand(["epic/child"], {
                sessionRuntime: runtime,
                sessionId,
                uiAPI: ui.uiAPI,
                editor: ui.editor,
            });

            assertEquals((await loadPlan(projectRoot, "epic/child"))?.attrs.status, "draft");
            assertStringIncludes(ui.messages.join("\n"), 'Parent Epic "epic" is on hold');
        } finally {
            runtime.closeAllSessions();
        }
    });
});

Deno.test("load-plan recursively loads a real child selected from an Epic", async () => {
    await withRuntimeCommandFixture("runwield-load-plan-command-", async ({ projectRoot }) => {
        await writePlan(projectRoot, "epic", { classification: "PROJECT", status: "ready_for_work" });
        await writePlan(projectRoot, "epic/child", { status: "draft", parentPlan: "epic", order: 1 });
        const { runtime, sessionId } = await createRuntime(projectRoot);
        const ui = makeUi(["pick_child", "epic/child", "load", "cancel"]);
        try {
            await runLoadPlanCommand(["epic"], {
                sessionRuntime: runtime,
                sessionId,
                uiAPI: ui.uiAPI,
                editor: ui.editor,
            });

            assertStringIncludes(ui.messages.join("\n"), "Plan loaded: epic/child");
            assertEquals((await loadPlan(projectRoot, "epic/child"))?.attrs.status, "draft");
        } finally {
            runtime.closeAllSessions();
        }
    });
});

Deno.test("load-plan adopts a plain Markdown file into the real Plan catalogue", async () => {
    await withRuntimeCommandFixture("runwield-load-plan-command-", async ({ projectRoot }) => {
        await Deno.mkdir(`${projectRoot}/docs/plans`, { recursive: true });
        await Deno.writeTextFile(`${projectRoot}/docs/plans/external.md`, "# External Plan\n\nKeep this body.\n");
        const { runtime, sessionId } = await createRuntime(projectRoot);
        const ui = makeUi(["cancel"]);
        try {
            await runLoadPlanCommand(["external"], {
                sessionRuntime: runtime,
                sessionId,
                uiAPI: ui.uiAPI,
                editor: ui.editor,
            });

            const plan = await loadPlan(projectRoot, "external");
            assertEquals(plan?.attrs.status, "draft");
            assertEquals(typeof plan?.attrs.planId, "string");
            assertStringIncludes(plan?.body || "", "Keep this body.");
            assertStringIncludes(ui.messages.join("\n"), "Adopted external as a RunWield Plan");
        } finally {
            runtime.closeAllSessions();
        }
    });
});

Deno.test("load-plan recovery rejects replaced worktree registry evidence before mutation", async () => {
    await withRuntimeCommandFixture("runwield-load-plan-command-", async ({ projectRoot }) => {
        const worktreePath = `${projectRoot}-failed-worktree`;
        const worktreeBranch = "worktree/failed-worktree-old";
        await writePlan(projectRoot, "failed-worktree", {
            status: "failed",
            planId: "plan-failed-worktree",
            executionMode: "worktree",
            worktreeId: "wt-old",
            worktreePath,
            worktreeBranch,
            worktreeBaseBranch: "main",
            worktreeStatus: "active",
            failureReason: "Fixture execution stopped",
        });
        await git(projectRoot, ["init", "-b", "main"]);
        await git(projectRoot, ["config", "user.email", "runwield@example.test"]);
        await git(projectRoot, ["config", "user.name", "RunWield Test"]);
        await git(projectRoot, ["add", "docs/plans/failed-worktree.md"]);
        await git(projectRoot, ["commit", "-m", "seed failed worktree Plan"]);
        const baseCommit = await git(projectRoot, ["rev-parse", "HEAD"]);
        await git(projectRoot, ["worktree", "add", "-b", worktreeBranch, worktreePath, "HEAD"]);
        try {
            await addEntry(projectRoot, {
                id: "wt-old",
                planName: "failed-worktree",
                planId: "plan-failed-worktree",
                baseBranch: "main",
                baseRef: "refs/heads/main",
                baseCommit,
                branch: worktreeBranch,
                path: worktreePath,
                status: "active",
                createdAt: "2026-01-01T00:00:00.000Z",
                updatedAt: "2026-01-01T00:00:00.000Z",
            });
            const evidence = await loadPlanActionEvidence(projectRoot, "plan-failed-worktree");
            if (evidence.kind !== "success") throw new Error(evidence.message);
            // Replace the actual attempt, not a retired Plan front-matter pointer.
            const old = await findById(projectRoot, "wt-old");
            if (!old) throw new Error("fixture attempt disappeared");
            await removeEntry(projectRoot, "wt-old");
            await addEntry(projectRoot, { ...old, id: "wt-new" });

            const result = await executePlanAction(projectRoot, {
                planId: "plan-failed-worktree",
                expectedRevision: evidence.evidence.revision,
                expectedStatus: evidence.evidence.status,
                expectedWorktree: evidence.evidence.worktree,
                action: "reset_to_draft",
            });

            assertEquals(result.kind, "recovery_required");
            assertEquals((await loadPlan(worktreePath, "failed-worktree"))?.attrs.status, "failed");
        } finally {
            await git(projectRoot, ["worktree", "remove", "--force", worktreePath]).catch(() => {});
        }
    });
});

Deno.test("load-plan enters real recovery for a failed Plan and cancellation preserves it", async () => {
    await withRuntimeCommandFixture("runwield-load-plan-command-", async ({ projectRoot }) => {
        await writePlan(projectRoot, "failed", {
            status: "failed",
            failureReason: "Fixture execution stopped",
            executionMode: "non_git_in_place",
        });
        const { runtime, sessionId } = await createRuntime(projectRoot);
        const ui = makeUi(["inspect", "cancel"]);
        try {
            await runLoadPlanCommand(["failed"], {
                sessionRuntime: runtime,
                sessionId,
                uiAPI: ui.uiAPI,
                editor: ui.editor,
            });

            assertEquals((await loadPlan(projectRoot, "failed"))?.attrs.status, "failed");
            assertEquals(ui.prompts.filter((prompt) => prompt === "Plan recovery (failed):").length, 2);
        } finally {
            runtime.closeAllSessions();
        }
    });
});

Deno.test("load-plan hold recovery exits after one prompt and puts the failed Plan on hold", async () => {
    await withRuntimeCommandFixture("runwield-load-plan-command-", async ({ projectRoot }) => {
        await writePlan(projectRoot, "failed-hold", {
            status: "failed",
            failureReason: "Fixture execution stopped",
            executionMode: "non_git_in_place",
        });
        const { runtime, sessionId } = await createRuntime(projectRoot);
        const ui = makeUi(["hold"]);
        try {
            await runLoadPlanCommand(["failed-hold"], {
                sessionRuntime: runtime,
                sessionId,
                uiAPI: ui.uiAPI,
                editor: ui.editor,
            });

            assertEquals((await loadPlan(projectRoot, "failed-hold"))?.attrs.status, "on_hold");
            assertEquals(ui.prompts.filter((prompt) => prompt === "Plan recovery (failed):").length, 1);
        } finally {
            runtime.closeAllSessions();
        }
    });
});

/**
 * The durable evidence for a managed Session: its committed generation and the
 * transcript byte length/terminal entry/digest that generation pins. A rename
 * hydrates the Session and publishes a new generation, so any hidden hydrating
 * mutation shows up here even when the visible name does not change.
 */
interface SessionDurableEvidence {
    name: string | null;
    generation: number | null;
    byteLength: number | null;
    terminalEntryId: string | null;
    digestHex: string | null;
}

function captureSessionDurableEvidence(runtime: SessionRuntime, sessionId: string): SessionDurableEvidence {
    const snapshot = runtime.getSessionSnapshot(sessionId);
    if (!snapshot) throw new Error("load-plan fixture Session disappeared");
    const runwieldSessionId = snapshot.managed?.runwieldSessionId;
    if (!runwieldSessionId) throw new Error("load-plan fixture Session is not managed");
    const store = openFileSessionStore();
    try {
        const control = store.inspectSessionActivation(runwieldSessionId);
        return {
            name: snapshot.name,
            generation: control.generation?.generation ?? null,
            byteLength: control.generation?.byteLength ?? null,
            terminalEntryId: control.generation?.terminalEntryId ?? null,
            digestHex: control.generation?.digestHex ?? null,
        };
    } finally {
        store.close();
    }
}

/**
 * Give the fixture Session one real committed turn. The Plan's acceptance
 * scenario is a long persisted Session; a turn-less Session would let the
 * post-command agent restore hide its own first hydration inside the evidence
 * being measured. With a committed turn behind it, View/Cancel must leave the
 * committed evidence byte-for-byte unchanged.
 */
async function warmSessionTurn(
    runtime: SessionRuntime,
    sessionId: string,
    setModelResponseFactory: (factory: FauxResponseFactory) => void,
): Promise<void> {
    setModelResponseFactory(() => fauxAssistantMessage(fauxText("Warm turn reply.")));
    await runtime.promptSession(sessionId, { initialRequest: "Warm the persisted Session." });
}

/**
 * Wrap the standard fixture UI so that every time the first post-selection
 * action menu opens, the Session's committed durable evidence is captured before
 * the scripted selection is returned. The menu boundary is where the user sees
 * their next choice, so evidence captured there proves everything that happened
 * before it did not mutate the Session.
 */
function makeUiCapturingActionMenu(
    selections: Array<string | null>,
    capture: () => SessionDurableEvidence,
): LoadPlanUiFixture & { menuEvidence: SessionDurableEvidence[] } {
    const ui = makeUi(selections);
    const menuEvidence: SessionDurableEvidence[] = [];
    const originalPromptSelect = ui.uiAPI.promptSelect;
    ui.uiAPI.promptSelect = (title: string, options: SelectOption[]) => {
        if (title === "What would you like to do?") menuEvidence.push(capture());
        return originalPromptSelect(title, options);
    };
    return { ...ui, menuEvidence };
}

Deno.test("load-plan selecting and canceling a draft Plan leaves the Session durable evidence untouched", async () => {
    await withRuntimeCommandFixture("runwield-load-plan-command-", async ({ projectRoot, setModelResponseFactory }) => {
        await writePlan(projectRoot, "untouched-draft", { status: "draft" });
        const { runtime, sessionId } = await createRuntime(projectRoot);
        await warmSessionTurn(runtime, sessionId, setModelResponseFactory);
        const before = captureSessionDurableEvidence(runtime, sessionId);
        const ui = makeUiCapturingActionMenu(
            ["untouched-draft", "cancel"],
            () => captureSessionDurableEvidence(runtime, sessionId),
        );
        try {
            await runLoadPlanCommand([], {
                sessionRuntime: runtime,
                sessionId,
                uiAPI: ui.uiAPI,
                editor: ui.editor,
            });
            // The Plan was chosen in the picker; the first post-selection menu is
            // the second prompt.
            assertEquals(ui.prompts[0], "Load plan:");
            assertEquals(ui.prompts[1], "What would you like to do?");
            // That menu opened exactly once, and at that boundary the Session had
            // not been hydrated, renamed, or republished.
            assertEquals(ui.menuEvidence.length, 1);
            assertEquals(ui.menuEvidence[0], before);
        } finally {
            runtime.closeAllSessions();
        }
    });
});

Deno.test("load-plan viewing then canceling a draft Plan leaves the Session durable evidence untouched", async () => {
    await withRuntimeCommandFixture("runwield-load-plan-command-", async ({ projectRoot, setModelResponseFactory }) => {
        await writePlan(projectRoot, "viewed-draft", { status: "draft" });
        const { runtime, sessionId } = await createRuntime(projectRoot);
        await warmSessionTurn(runtime, sessionId, setModelResponseFactory);
        const before = captureSessionDurableEvidence(runtime, sessionId);
        const ui = makeUiCapturingActionMenu(
            ["viewed-draft", "view", "cancel"],
            () => captureSessionDurableEvidence(runtime, sessionId),
        );
        try {
            await runLoadPlanCommand([], {
                sessionRuntime: runtime,
                sessionId,
                uiAPI: ui.uiAPI,
                editor: ui.editor,
            });
            assertEquals(ui.prompts[0], "Load plan:");
            // The second prompt and the re-prompt after View both see the same
            // committed evidence: viewing never hydrates or renames the Session.
            assertEquals(ui.menuEvidence.length, 2);
            assertEquals(ui.menuEvidence[0], before);
            assertEquals(ui.menuEvidence[1], before);
            assertStringIncludes(ui.messages.join("\n"), "Plan loaded: viewed-draft");
            // After View then Cancel the command has returned: the Session name,
            // generation, transcript byte length, terminal entry, and digest are
            // all exactly as they were before Plan selection.
            assertEquals(captureSessionDurableEvidence(runtime, sessionId), before);
        } finally {
            runtime.closeAllSessions();
        }
    });
});

Deno.test("load-plan resuming a draft Plan publishes exactly one Plan-named generation before Agent work", async () => {
    await withRuntimeCommandFixture(
        "runwield-load-plan-command-",
        async ({ projectRoot, setModelResponseFactory }) => {
            await writePlan(projectRoot, "resumed-draft", { status: "draft" });
            const { runtime, sessionId } = await createRuntime(projectRoot);
            await warmSessionTurn(runtime, sessionId, setModelResponseFactory);
            setModelResponseFactory(() =>
                fauxAssistantMessage(fauxToolCall("plan_written", { planName: "resumed-draft" }))
            );
            runtime.setInteractionAdapter(sessionId, {
                requestInteraction: async () => {
                    const current = await loadPlan(projectRoot, "resumed-draft");
                    if (!current) throw new Error("Fixture Plan disappeared before review");
                    return {
                        outcome: "accepted",
                        _meta: {
                            approved: true,
                            approvalAction: "later",
                            revision: current.revision,
                            planAttrs: current.attrs,
                        },
                    };
                },
            });
            // Capture the committed evidence at every Agent-switch boundary. The
            // continuation must claim the Session before the switch that opens the
            // Planner: at that boundary exactly one new generation may exist, and
            // it must carry the Plan name.
            const switchEvidence: SessionDurableEvidence[] = [];
            const originalSwitchAgent = runtime.switchAgent.bind(runtime);
            runtime.switchAgent = (switchSessionId, options) => {
                if (switchSessionId === sessionId) {
                    switchEvidence.push(captureSessionDurableEvidence(runtime, sessionId));
                }
                return originalSwitchAgent(switchSessionId, options);
            };
            const ui = makeUi(["resumed-draft", "resume"]);
            try {
                const before = captureSessionDurableEvidence(runtime, sessionId);
                await runLoadPlanCommand([], {
                    sessionRuntime: runtime,
                    sessionId,
                    uiAPI: ui.uiAPI,
                    editor: ui.editor,
                });
                assertEquals(ui.prompts[0], "Load plan:");
                assertEquals(ui.prompts[1], "What would you like to do?");
                assertEquals(switchEvidence.length >= 1, true, "the Planner switch never ran");
                assertEquals(switchEvidence[0].name, "resumed-draft");
                assertEquals(switchEvidence[0].generation, (before.generation ?? 0) + 1);
                const after = captureSessionDurableEvidence(runtime, sessionId);
                assertEquals(after.name, "resumed-draft");
            } finally {
                runtime.switchAgent = originalSwitchAgent;
                runtime.closeAllSessions();
            }
        },
    );
});

Deno.test("activateForPlan renames the Session exactly once across repeated continuation calls", async () => {
    await withRuntimeCommandFixture("runwield-load-plan-command-", async ({ projectRoot }) => {
        const { runtime, sessionId } = await createRuntime(projectRoot);
        try {
            const surface = createPlanSessionSurface(runtime, sessionId, {
                executePlan: () => Promise.resolve({ ok: true }),
                runPlanningAgent: () => Promise.resolve({ ok: true }),
                runValidation: () => Promise.resolve({ ok: true }),
                runSlicerAgent: () => Promise.resolve({ ok: true }),
            });
            const baseline = captureSessionDurableEvidence(runtime, sessionId);
            await surface.activateForPlan("claimed-plan");
            const afterFirst = captureSessionDurableEvidence(runtime, sessionId);
            assertEquals(afterFirst.name, "claimed-plan");
            assertEquals(afterFirst.generation !== baseline.generation, true);
            // Menus can loop and call activateForPlan again; the durable rename must not repeat.
            await surface.activateForPlan("claimed-plan");
            await surface.activateForPlan("some-other-plan");
            const afterRepeat = captureSessionDurableEvidence(runtime, sessionId);
            assertEquals(afterRepeat, afterFirst);
        } finally {
            runtime.closeAllSessions();
        }
    });
});

Deno.test("load-plan abandon names a rescue branch and cleanup can be retried after merging it", async () => {
    await withRuntimeCommandFixture("runwield-discard-rescue-", async ({ projectRoot }) => {
        const attempt = await prepareImplementedFollowUpPlan(projectRoot);
        await Deno.writeTextFile(`${attempt.worktreePath}/rescue.txt`, "keep this work\n");
        await git(attempt.worktreePath, ["add", "rescue.txt"]);
        await git(attempt.worktreePath, ["commit", "-m", "unique work"]);
        const beforeHead = await git(projectRoot, ["rev-parse", "HEAD"]);
        const { runtime, sessionId } = await createRuntime(projectRoot);
        const ui = makeUi(["abandon", "confirm", null]);
        try {
            await runLoadPlanCommand([attempt.planName], {
                sessionRuntime: runtime,
                sessionId,
                uiAPI: ui.uiAPI,
                editor: ui.editor,
            });
            assertStringIncludes(ui.messages.join("\n"), `Branch ${attempt.worktreeBranch} was kept for manual rescue`);
            assertEquals(await git(projectRoot, ["rev-parse", "HEAD"]), beforeHead);
            assertEquals(await git(projectRoot, ["branch", "--show-current"]), "main");
            assertEquals((await findById(projectRoot, "follow-up-worktree"))?.status, "abandoned");
            assertEquals(await git(projectRoot, ["show", `${attempt.worktreeBranch}:rescue.txt`]), "keep this work");
            await git(projectRoot, ["merge", "--ff-only", attempt.worktreeBranch]);
            const entry = await findById(projectRoot, "follow-up-worktree");
            if (!entry) throw new Error("rescue record missing");
            const results = [];
            for await (const result of discardWorktreeGitArtifacts({ projectRoot, ...entry })) results.push(result);
            assertEquals(results.at(-1)?.status, "complete");
            assertEquals(await git(projectRoot, ["branch", "--list", attempt.worktreeBranch]), "");
        } finally {
            runtime.closeAllSessions();
            await Deno.remove(attempt.worktreePath, { recursive: true }).catch(() => {});
        }
    });
});
