import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { withRuntimeCommandFixture } from "../../cmd/testing/runtime-command-fixture.ts";
import { loadPlan, savePlan } from "../../plan-store.js";
import { git } from "../git-test-fixture.ts";
import { HostedSession } from "../session/hosted-session.js";
import { setCustomSetting } from "../settings.js";
import type { RuntimeInteractionRequest, RuntimeInteractionResponse } from "../session/session-runtime-interactions.js";
import { listEntries as listWorktreeRegistryEntries } from "../worktree-registry.js";
import { executePlan } from "./plan-executor.ts";

interface PlanExecutorSessionFixture {
    hostedSession: HostedSession;
    sessionManager: SessionManager;
}

type InteractionHandler = (request: RuntimeInteractionRequest) => RuntimeInteractionResponse;

function createSessionFixture(
    projectRoot: string,
    interaction?: InteractionHandler,
): PlanExecutorSessionFixture {
    const sessionManager = SessionManager.inMemory(projectRoot);
    const hostedSession = new HostedSession({
        id: `plan-executor-${crypto.randomUUID()}`,
        cwd: projectRoot,
        interactionAdapter: {
            supportsInteraction: (type) => type === "pair_checkpoint",
            requestInteraction: (request) =>
                interaction?.(request) ?? { outcome: "canceled", message: "Fixture supplied no answer." },
        },
    });
    // Pi's concrete manager implements the HostedSession runtime contract.
    hostedSession.setRootSessionManager(sessionManager);
    return { hostedSession, sessionManager };
}

async function initializeGitProject(projectRoot: string): Promise<void> {
    await git(projectRoot, ["init", "-b", "main"]);
    await git(projectRoot, ["config", "user.email", "test@example.com"]);
    await git(projectRoot, ["config", "user.name", "RunWield Test"]);
    await Deno.writeTextFile(`${projectRoot}/README.md`, "fixture\n");
    await git(projectRoot, ["add", "."]);
    await git(projectRoot, ["commit", "-m", "fixture: initial project"]);
}

async function saveExecutablePlan(
    projectRoot: string,
    planName: string,
    attrs: Parameters<typeof savePlan>[3] = {},
): Promise<void> {
    await savePlan(projectRoot, planName, `# ${planName}`, {
        classification: "PLANNED_CHANGE",
        complexity: "MEDIUM",
        summary: planName,
        affectedPaths: ["implemented.txt"],
        status: "ready_for_work",
        executionAgent: "engineer",
        planId: `plan-${crypto.randomUUID()}`,
        ...attrs,
    });
}

Deno.test("executePlan rejects a persisted Epic before starting an Agent", async () => {
    await withRuntimeCommandFixture("plan-executor-epic-", async ({ projectRoot, setModelResponseFactory }) => {
        await initializeGitProject(projectRoot);
        await saveExecutablePlan(projectRoot, "epic", {
            classification: "PROJECT",
            status: "ready_for_decomposition",
            executionAgent: undefined,
        });
        let modelCalls = 0;
        setModelResponseFactory(() => {
            modelCalls += 1;
            return fauxAssistantMessage(fauxText("Unexpected Agent call."));
        });
        const fixture = createSessionFixture(projectRoot);

        try {
            const result = await executePlan({
                planName: "epic",
                triageMeta: { classification: "PLANNED_CHANGE" },
                sessionManager: fixture.sessionManager,
                hostedSession: fixture.hostedSession,
            });

            assertEquals(result.executionComplete, false);
            assertStringIncludes(result.error ?? "", "PROJECT Epic container");
            assertEquals(modelCalls, 0);
            assertEquals(fixture.hostedSession.getActiveExecutionWorkflow(), null);
        } finally {
            fixture.hostedSession.dispose();
        }
    });
});

Deno.test("executePlan recovers a genuinely missing Plan through the HostedSession interaction port", async () => {
    await withRuntimeCommandFixture("plan-executor-missing-", async ({ projectRoot }) => {
        const requests: RuntimeInteractionRequest[] = [];
        const fixture = createSessionFixture(projectRoot, (request) => {
            requests.push(request);
            return { outcome: "canceled", value: false };
        });

        try {
            const result = await executePlan({
                planName: "missing",
                triageMeta: { classification: "PLANNED_CHANGE" },
                sessionManager: fixture.sessionManager,
                hostedSession: fixture.hostedSession,
            });

            assertEquals(requests.map((request) => request.type), ["approval"]);
            assertEquals(result.intentionalComplete, true);
            assertEquals(result.intentionalCompleteReason, "plan_not_found");
            assertEquals(await loadPlan(projectRoot, "missing"), null);
        } finally {
            fixture.hostedSession.dispose();
        }
    });
});

Deno.test("executePlan runs preparation, Engineer, checkpoint, lifecycle, and registry machinery together", async () => {
    await withRuntimeCommandFixture("plan-executor-complete-", async ({ projectRoot, setModelMessages }) => {
        await initializeGitProject(projectRoot);
        await saveExecutablePlan(projectRoot, "feature");
        setModelMessages([
            fauxAssistantMessage(fauxToolCall("write", {
                path: "implemented.txt",
                content: "implemented in execution worktree\n",
            })),
            fauxAssistantMessage(fauxToolCall("task_completed", {
                message: "- Implemented the fixture.\n- Verified the fixture.",
            })),
        ]);
        const fixture = createSessionFixture(projectRoot);

        try {
            const result = await executePlan({
                planName: "feature",
                triageMeta: { classification: "PLANNED_CHANGE" },
                sessionManager: fixture.sessionManager,
                hostedSession: fixture.hostedSession,
                routerMessage: "Implement the fixture Plan.",
            });

            assertEquals(result.executionComplete, true);
            assertEquals(result.repairRequired, false);
            assertEquals(result.executionContext?.executionMode, "worktree");
            assert(result.executionContext?.executionCwd);
            assertEquals(
                await Deno.readTextFile(`${result.executionContext.executionCwd}/implemented.txt`),
                "implemented in execution worktree\n",
            );
            assertEquals(await Deno.stat(`${projectRoot}/implemented.txt`).then(() => true).catch(() => false), false);
            const persisted = await loadPlan(result.executionContext.executionCwd, "feature");
            assertEquals(persisted?.attrs.status, "implemented");
            assertEquals(persisted?.attrs.executionReport, "- Implemented the fixture.\n- Verified the fixture.");
            const registryEntries = await listWorktreeRegistryEntries(projectRoot);
            assertEquals(registryEntries.length, 1);
            assertEquals(registryEntries[0].status, "completed");
        } finally {
            fixture.hostedSession.dispose();
        }
    });
});

Deno.test("executePlan carries project validation settings without hiding the versionable file", async () => {
    await withRuntimeCommandFixture("plan-executor-ci-settings-", async ({ projectRoot, setModelMessages }) => {
        await initializeGitProject(projectRoot);
        await setCustomSetting("verification_command", "printf primary", "project", projectRoot);
        await saveExecutablePlan(projectRoot, "ci-settings");
        setModelMessages([
            fauxAssistantMessage(fauxToolCall("write", {
                path: "implemented.txt",
                content: "implemented\n",
            })),
            fauxAssistantMessage(fauxToolCall("task_completed", {
                message: "- Implemented the fixture.\n- Verified setup.",
            })),
        ]);
        const fixture = createSessionFixture(projectRoot);

        try {
            const result = await executePlan({
                planName: "ci-settings",
                triageMeta: { classification: "PLANNED_CHANGE" },
                sessionManager: fixture.sessionManager,
                hostedSession: fixture.hostedSession,
            });

            const executionCwd = result.executionContext?.executionCwd;
            assert(executionCwd, JSON.stringify(result));
            const primarySettings = await Deno.readTextFile(`${projectRoot}/.wld/settings.json`);
            assertEquals(await Deno.readTextFile(`${executionCwd}/.wld/settings.json`), primarySettings);
            assertStringIncludes(await git(executionCwd, ["show", "HEAD:.wld/settings.json"]), "printf primary");
            const exclude = await new Deno.Command("git", {
                args: ["rev-parse", "--git-path", "info/exclude"],
                cwd: executionCwd,
                stdout: "piped",
                stderr: "piped",
            }).output();
            assertEquals(exclude.code, 0);
            const rawExcludePath = new TextDecoder().decode(exclude.stdout).trim();
            const excludePath = rawExcludePath.startsWith("/") ? rawExcludePath : `${executionCwd}/${rawExcludePath}`;
            const excludeText = await Deno.readTextFile(excludePath);
            assertEquals(excludeText.split(/\r?\n/).includes(".wld/settings.json"), false);
        } finally {
            fixture.hostedSession.dispose();
        }
    });
});

Deno.test("executePlan leaves real execution state resumable when Engineer omits task_completed", async () => {
    await withRuntimeCommandFixture("plan-executor-paused-", async ({ projectRoot, setModelMessages }) => {
        await initializeGitProject(projectRoot);
        await saveExecutablePlan(projectRoot, "paused-feature");
        setModelMessages([fauxAssistantMessage(fauxText("I need another turn before completion."))]);
        const fixture = createSessionFixture(projectRoot);

        try {
            const result = await executePlan({
                planName: "paused-feature",
                triageMeta: { classification: "PLANNED_CHANGE" },
                sessionManager: fixture.sessionManager,
                hostedSession: fixture.hostedSession,
            });

            assertEquals(result.executionComplete, false);
            assertEquals(result.repairRequired, false);
            assertEquals(result.executionContext?.executionMode, "worktree");
            assert(result.executionContext?.executionCwd);
            assertEquals(
                (await loadPlan(result.executionContext.executionCwd, "paused-feature"))?.attrs.status,
                "in_progress",
            );
            assertEquals(fixture.hostedSession.getActiveExecutionWorkflow()?.planName, "paused-feature");
            assertEquals((await listWorktreeRegistryEntries(projectRoot))[0]?.status, "active");
        } finally {
            fixture.hostedSession.dispose();
        }
    });
});

Deno.test("executePlan resolves Pair collaboration from the real Plan and host capability", async () => {
    await withRuntimeCommandFixture("plan-executor-pair-", async ({ projectRoot, setModelMessages }) => {
        await initializeGitProject(projectRoot);
        await saveExecutablePlan(projectRoot, "visual-feature", {
            executionAgent: "frontend-engineer",
            collaborationRecommendation: "pair",
        });
        setModelMessages([fauxAssistantMessage(fauxText("Pair execution is paused for another increment."))]);
        const fixture = createSessionFixture(projectRoot);

        try {
            const result = await executePlan({
                planName: "visual-feature",
                triageMeta: { classification: "PLANNED_CHANGE" },
                sessionManager: fixture.sessionManager,
                hostedSession: fixture.hostedSession,
            });

            assertEquals(result.executionComplete, false);
            assertEquals(result.executionContext?.executionAgent, "frontend-engineer");
            assertEquals(result.executionContext?.collaborationStyle, "pair");
            assertEquals(result.executionContext?.collaborationRecommendation, "pair");
        } finally {
            fixture.hostedSession.dispose();
        }
    });
});
