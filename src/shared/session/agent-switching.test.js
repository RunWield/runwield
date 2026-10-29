import { mkdtemp as fsMkdtemp, readFile as fsReadFile, writeFile as fsWriteFile } from "node:fs/promises";
import { test } from "node:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ok as assert, strictEqual as assertStrictEquals } from "node:assert/strict";
import { assertEquals, assertRejects } from "../../testing/assertions.ts";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxText, getCurrentTools, getSystemMessageText } from "@earendil-works/pi-ai";
import { withRuntimeCommandFixture } from "../../cmd/testing/runtime-command-fixture.ts";
import { runActiveAgentTurn, switchActiveAgent } from "./agent-switching.js";
import { __getRootSessionMetadataForTests } from "./session.js";
import { HostedSession } from "./hosted-session.js";
import { RuntimeEventTypes } from "./session-runtime-events.js";
import { createReplayEvents } from "./session-transcript-projection.js";
/** @typedef {{ type: string, agentName?: string, rootHandoff?: boolean }} AgentNoticeEvent */
import {
    BACKEND_CONTINUATION_REQUEST,
    failRequestDispatch,
    prepareRequestDispatch,
    readRequestAttemptEntries,
} from "./request-dispatch.ts";

/**
 * @param {string} projectRoot
 */
function makeSession(projectRoot) {
    const sessionManager = SessionManager.inMemory(projectRoot);
    const hostedSession = new HostedSession({
        id: `root-switch-${crypto.randomUUID()}`,
        cwd: projectRoot,
        sessionManager: /** @type {any} */ (sessionManager),
    });
    return { hostedSession, sessionManager };
}

test("Agent switches replace provider system instructions while retaining conversation history", async () => {
    await withRuntimeCommandFixture(
        "agent-switch-provider-prompt-",
        async ({ projectRoot, setModelResponseFactory }) => {
            const initial = makeSession(projectRoot);
            const sessionManager = initial.sessionManager;
            let hostedSession = initial.hostedSession;
            /** @type {import('@earendil-works/pi-ai').TranscriptContext[]} */
            const requests = [];
            try {
                for (const agentName of ["router", "ideator", "engineer", "engineer", "engineer", "router"]) {
                    if (requests.length === 4) {
                        hostedSession.dispose();
                        hostedSession = new HostedSession({
                            id: `restored-switch-${crypto.randomUUID()}`,
                            cwd: projectRoot,
                            sessionManager,
                        });
                    }
                    setModelResponseFactory((context) => {
                        requests.push(structuredClone(context));
                        return fauxAssistantMessage(fauxText("Previous conversation retained."));
                    });
                    await runActiveAgentTurn({
                        hostedSession,
                        agentName,
                        sessionManager,
                        userRequest: `Request for ${agentName}.`,
                    });
                }

                assertEquals(requests.length, 6);
                for (const index of [2, 3, 4]) {
                    const request = requests[index];
                    const systems = request.messages.filter((message) => message.role === "system");
                    assertEquals(systems.length, 1);
                    assertEquals(request.messages[0].role, "system");
                    const prompt = getSystemMessageText(systems[0]);
                    assert(prompt.includes("You are the Engineer"));
                    assert(!prompt.includes("Your ONLY job is to identify the Routing Intent"));
                    assert(!prompt.includes("You are the Ideator"));
                    const toolNames = getCurrentTools(request.messages).map((tool) => tool.name);
                    assert(toolNames.includes("edit"));
                    assert(toolNames.includes("task_completed"));
                    assert(!toolNames.includes("triage_report"));
                    assert(JSON.stringify(request.messages).includes("Request for router."));
                    assert(JSON.stringify(request.messages).includes("Previous conversation retained."));
                }

                const routerSystems = requests[5].messages.filter((message) => message.role === "system");
                assertEquals(routerSystems.length, 1);
                assert(
                    getSystemMessageText(routerSystems[0]).includes("Your ONLY job is to identify the Routing Intent"),
                );
                assert(!getSystemMessageText(routerSystems[0]).includes("You are the Engineer"));
                assert(getCurrentTools(requests[5].messages).some((tool) => tool.name === "triage_report"));
                // Request projection must not erase the durable prompt-change evidence.
                const savedSystems = sessionManager.buildSessionContext().messages.filter((message) =>
                    message.role === "system"
                );
                assert(savedSystems.length > 1);
            } finally {
                hostedSession.dispose();
            }
        },
    );
});

test("switchActiveAgent rebuilds same Agent roots when cwd changes", async () => {
    await withRuntimeCommandFixture("agent-switch-cwd-rebuild-", async ({ projectRoot }) => {
        const nextRoot = await fsMkdtemp(join(tmpdir(), "runwield-agent-switch-next-"));
        const { hostedSession, sessionManager } = makeSession(projectRoot);
        await switchActiveAgent(hostedSession, { agentName: "guide", sessionManager });
        const firstRoot = hostedSession.getRootAgentSession();

        await switchActiveAgent(hostedSession, {
            agentName: "guide",
            cwd: nextRoot,
            sessionManager,
        });

        const secondRoot = hostedSession.getRootAgentSession();
        assert(secondRoot && secondRoot !== firstRoot);
        assertEquals(hostedSession.cwd, nextRoot);
        assertEquals(__getRootSessionMetadataForTests(/** @type {any} */ (secondRoot))?.cwd, nextRoot);
        hostedSession.dispose();
    });
});

test("switchActiveAgent installs a real matching Agent root and handler", async () => {
    await withRuntimeCommandFixture("agent-switch-install-", async ({ projectRoot }) => {
        const { hostedSession, sessionManager } = makeSession(projectRoot);
        /** @type {Array<{ type?: string, agentName?: string }>} */
        const events = [];
        hostedSession.setEventSink((/** @type {{ type?: string, agentName?: string }} */ event) => events.push(event));

        const result = await switchActiveAgent(hostedSession, {
            agentName: "guide",
            sessionManager,
        });

        assertEquals(result, { ok: true, agentName: "guide", changed: true, model: undefined });
        assertEquals(hostedSession.getRootAgentName(), "guide");
        assertEquals(
            typeof /** @type {{ prompt?: Function } | null} */ (hostedSession.getRootAgentSession())?.prompt,
            "function",
        );
        assertEquals(typeof hostedSession.getActiveOnMessage(), "function");
        const agentEvents = events.filter((event) =>
            event.type === RuntimeEventTypes.AGENT_CHANGED && event.agentName === "guide"
        );
        assertEquals(agentEvents.length, 1);
        assertEquals(/** @type {any} */ (agentEvents[0]).displayName, "Guide");
        assertEquals(/** @type {any} */ (agentEvents[0]).rootHandoff, undefined);
        hostedSession.dispose();
    });
});

test("switchActiveAgent reports a user switch from the unpersisted prompt-ready Agent", async () => {
    await withRuntimeCommandFixture("agent-switch-prompt-ready-", async ({ projectRoot }) => {
        const { hostedSession, sessionManager } = makeSession(projectRoot);
        hostedSession.resetAgentInfoStack("Guide", "", "", "guide");
        /** @type {AgentNoticeEvent[]} */
        const events = [];
        hostedSession.setEventSink((/** @type {AgentNoticeEvent} */ event) => events.push(event));
        await switchActiveAgent(hostedSession, { agentName: "planner", sessionManager, releaseActiveWorkflow: true });
        const changed = events.filter((event) => event.type === RuntimeEventTypes.AGENT_CHANGED);
        assertEquals(changed.map((event) => [event.agentName, event.rootHandoff]), [["planner", true]]);
        hostedSession.dispose();
    });
});

test("switchActiveAgent marks only successful different root switches as handoffs", async () => {
    await withRuntimeCommandFixture("agent-switch-handoff-", async ({ projectRoot }) => {
        const { hostedSession, sessionManager } = makeSession(projectRoot);
        /** @type {Array<Record<string, unknown>>} */
        const events = [];
        hostedSession.setEventSink((/** @type {unknown} */ event) =>
            events.push(/** @type {Record<string, unknown>} */ (event))
        );

        await switchActiveAgent(hostedSession, { agentName: "guide", sessionManager });
        await switchActiveAgent(hostedSession, { agentName: "planner", sessionManager });
        await switchActiveAgent(hostedSession, { agentName: "planner", forceRebuild: true, sessionManager });

        const agentEvents = events.filter((event) => event.type === RuntimeEventTypes.AGENT_CHANGED);
        assertEquals(agentEvents.map((event) => [event.agentName, event.displayName, event.rootHandoff]), [
            ["guide", "Guide", undefined],
            ["planner", "Planner", true],
            ["planner", "Planner", undefined],
        ]);
        hostedSession.dispose();
    });
});

test("switchActiveAgent marks a presented Agent change while replay keeps the first marker silent", async () => {
    await withRuntimeCommandFixture("agent-switch-presented-baseline-", async ({ projectRoot }) => {
        const { hostedSession, sessionManager } = makeSession(projectRoot);
        hostedSession.pushAgentInfo("Guide", "", "", "guide");
        /** @type {Array<Record<string, unknown>>} */
        const events = [];
        hostedSession.setEventSink((/** @type {unknown} */ event) =>
            events.push(/** @type {Record<string, unknown>} */ (event))
        );

        await switchActiveAgent(hostedSession, { agentName: "planner", sessionManager });

        const liveAgentEvents = events.filter((event) => event.type === RuntimeEventTypes.AGENT_CHANGED);
        assertEquals(liveAgentEvents.map((event) => [event.agentName, event.displayName, event.rootHandoff]), [
            ["planner", "Planner", true],
        ]);
        const replayEvents = createReplayEvents("presented-baseline", sessionManager.getBranch(), { projectRoot });
        assertEquals(
            replayEvents.filter((event) =>
                event.type === RuntimeEventTypes.SYSTEM_STATUS && event.message === "Agent switched to Planner"
            ).length,
            0,
        );
        hostedSession.dispose();
    });
});

test("switchActiveAgent leaves the previous real root transaction intact when replacement construction fails", async () => {
    await withRuntimeCommandFixture("agent-switch-rollback-", async ({ projectRoot }) => {
        const { hostedSession, sessionManager } = makeSession(projectRoot);
        await switchActiveAgent(hostedSession, {
            agentName: "guide",
            sessionManager,
        });
        const previousRoot = hostedSession.getRootAgentSession();
        const previousHandler = hostedSession.getActiveOnMessage();
        const transitionId = hostedSession.beginAgentTransition();
        hostedSession.queueAgentTransitionSteering("retain after failure", []);

        await assertRejects(
            () =>
                switchActiveAgent(hostedSession, {
                    agentName: "guide",
                    model: "missing-provider/missing-model",
                    forceRebuild: true,
                    sessionManager,
                }),
            Error,
            "Unknown invocation model override",
        );

        assertEquals(hostedSession.getRootAgentName(), "guide");
        assertStrictEquals(hostedSession.getRootAgentSession(), previousRoot);
        assertStrictEquals(hostedSession.getActiveOnMessage(), previousHandler);
        assertEquals(hostedSession.getAgentTransitionId(), transitionId);
        assertEquals(hostedSession.consumeAgentTransitionSteering().map((entry) => entry.text), [
            "retain after failure",
        ]);
        hostedSession.completeAgentTransition(transitionId);
        hostedSession.dispose();
    });
});

test("runActiveAgentTurn switches and completes a real root turn through the faux model boundary", async () => {
    await withRuntimeCommandFixture(
        "active-agent-turn-",
        async ({ projectRoot, setModelResponse }) => {
            setModelResponse("The isolated Guide turn completed.");
            const { hostedSession, sessionManager } = makeSession(projectRoot);

            const messages = await runActiveAgentTurn({
                hostedSession,
                agentName: "guide",
                userRequest: "Explain the fixture.",
                sessionManager,
            });

            assertEquals(hostedSession.getRootAgentName(), "guide");
            assertEquals(JSON.stringify(messages).includes("The isolated Guide turn completed."), true);
            hostedSession.dispose();
        },
    );
});

test("switchActiveAgent resolves the active preset model when Router dispatches QUICK_FIX to Engineer", async () => {
    await withRuntimeCommandFixture(
        "agent-switch-quick-fix-preset-",
        async ({ homeDir, projectRoot, settingsPath }) => {
            const { hostedSession, sessionManager } = makeSession(projectRoot);
            await fsWriteFile(
                settingsPath,
                JSON.stringify({
                    activeModelPreset: "split-agents",
                    modelPresets: {
                        "split-agents": {
                            agents: {
                                router: { model: "runtime-command-fixture/router-model" },
                                engineer: { model: "runtime-command-fixture/engineer-model" },
                                guide: { model: "runtime-command-fixture/guide-model" },
                            },
                        },
                        "alternate-agents": {
                            agents: {
                                engineer: { model: "runtime-command-fixture/engineer-alt-model" },
                            },
                        },
                    },
                    notifications: { enabled: false },
                }),
            );
            await fsWriteFile(
                `${homeDir}/.wld/models.json`,
                JSON.stringify({
                    providers: {
                        "runtime-command-fixture": {
                            name: "Runtime Command Fixture Provider",
                            baseUrl: "http://127.0.0.1:0",
                            apiKey: "fixture-key",
                            api: "runtime-command-faux",
                            models: [
                                {
                                    id: "router-model",
                                    name: "Router Model",
                                    api: "runtime-command-faux",
                                    input: ["text", "image"],
                                    contextWindow: 128000,
                                    maxTokens: 4096,
                                },
                                {
                                    id: "engineer-model",
                                    name: "Engineer Model",
                                    api: "runtime-command-faux",
                                    input: ["text", "image"],
                                    contextWindow: 128000,
                                    maxTokens: 4096,
                                },
                                {
                                    id: "guide-model",
                                    name: "Guide Model",
                                    api: "runtime-command-faux",
                                    input: ["text", "image"],
                                    contextWindow: 128000,
                                    maxTokens: 4096,
                                },
                                {
                                    id: "engineer-alt-model",
                                    name: "Engineer Alternate Model",
                                    api: "runtime-command-faux",
                                    input: ["text", "image"],
                                    contextWindow: 128000,
                                    maxTokens: 4096,
                                },
                            ],
                        },
                    },
                }),
            );

            await switchActiveAgent(hostedSession, { agentName: "router", sessionManager });
            const routerRoot = hostedSession.getRootAgentSession();
            assert(routerRoot);
            assertEquals(
                __getRootSessionMetadataForTests(
                    /** @type {import("@earendil-works/pi-coding-agent").AgentSession} */ (routerRoot),
                )?.model,
                "runtime-command-fixture/router-model",
            );

            await switchActiveAgent(hostedSession, { agentName: "guide", sessionManager });
            const guideRoot = hostedSession.getRootAgentSession();
            assert(guideRoot);
            assertEquals(
                __getRootSessionMetadataForTests(
                    /** @type {import("@earendil-works/pi-coding-agent").AgentSession} */ (guideRoot),
                )?.model,
                "runtime-command-fixture/guide-model",
            );

            await switchActiveAgent(hostedSession, { agentName: "engineer", sessionManager });

            assertEquals(hostedSession.getRootAgentName(), "engineer");
            const engineerRoot = hostedSession.getRootAgentSession();
            assert(engineerRoot);
            assertEquals(
                __getRootSessionMetadataForTests(
                    /** @type {import("@earendil-works/pi-coding-agent").AgentSession} */ (engineerRoot),
                )?.model,
                "runtime-command-fixture/engineer-model",
            );
            const persistedModelChanges = sessionManager.getBranch().filter((entry) => entry.type === "model_change");
            assertEquals(
                {
                    provider: persistedModelChanges.at(-1)?.provider,
                    modelId: persistedModelChanges.at(-1)?.modelId,
                },
                {
                    provider: "runtime-command-fixture",
                    modelId: "engineer-model",
                },
            );

            const alternateSettings = JSON.parse(await fsReadFile(settingsPath, "utf8"));
            alternateSettings.activeModelPreset = "alternate-agents";
            await fsWriteFile(settingsPath, JSON.stringify(alternateSettings));
            await switchActiveAgent(hostedSession, { agentName: "engineer", sessionManager });

            const alternateEngineerRoot = hostedSession.getRootAgentSession();
            assert(alternateEngineerRoot);
            assertEquals(alternateEngineerRoot === engineerRoot, false);
            assertEquals(
                __getRootSessionMetadataForTests(
                    /** @type {import("@earendil-works/pi-coding-agent").AgentSession} */ (alternateEngineerRoot),
                )?.model,
                "runtime-command-fixture/engineer-alt-model",
            );
            hostedSession.dispose();
        },
    );
});

test("switchActiveAgent reuses an unchanged real root and handler", async () => {
    await withRuntimeCommandFixture("agent-switch-reuse-", async ({ projectRoot }) => {
        const { hostedSession, sessionManager } = makeSession(projectRoot);
        await switchActiveAgent(hostedSession, {
            agentName: "guide",
            sessionManager,
        });
        const previousRoot = hostedSession.getRootAgentSession();
        const previousHandler = hostedSession.getActiveOnMessage();

        const result = await switchActiveAgent(hostedSession, {
            agentName: "guide",
        });

        assertEquals(result, { ok: true, agentName: "guide", changed: false, model: undefined });
        assertStrictEquals(hostedSession.getRootAgentSession(), previousRoot);
        assertStrictEquals(hostedSession.getActiveOnMessage(), previousHandler);
        hostedSession.dispose();
    });
});

test("switchActiveAgent replaces a stale handler without rebuilding the matching real root", async () => {
    await withRuntimeCommandFixture("agent-switch-stale-handler-", async ({ projectRoot }) => {
        const { hostedSession, sessionManager } = makeSession(projectRoot);
        await switchActiveAgent(hostedSession, { agentName: "guide", sessionManager });
        const previousRoot = hostedSession.getRootAgentSession();
        const staleHandler = () => Promise.resolve({ kind: "complete" });
        hostedSession.setActiveOnMessage(staleHandler);

        const result = await switchActiveAgent(hostedSession, { agentName: "guide" });

        assertEquals(result.changed, true);
        assertStrictEquals(hostedSession.getRootAgentSession(), previousRoot);
        assertEquals(hostedSession.getActiveOnMessage() === staleHandler, false);
        hostedSession.dispose();
    });
});

test("switchActiveAgent rebuilds a real same-Agent root when forceRebuild is set", async () => {
    await withRuntimeCommandFixture("agent-switch-policy-", async ({ projectRoot }) => {
        const { hostedSession, sessionManager } = makeSession(projectRoot);
        await switchActiveAgent(hostedSession, {
            agentName: "guide",
            sessionManager,
        });
        const previousRoot = hostedSession.getRootAgentSession();

        const result = await switchActiveAgent(hostedSession, {
            agentName: "guide",
            sessionManager,
            forceRebuild: true,
        });

        assertEquals(result.changed, true);
        assertEquals(hostedSession.getRootAgentSession() === previousRoot, false);
        hostedSession.dispose();
    });
});

test("provider switch continues a failed request without changing execution ownership or worktree", async () => {
    await withRuntimeCommandFixture(
        "agent-switch-backend-continuation-",
        async ({ projectRoot, setModelResponse }) => {
            setModelResponse("Continuation completed.");
            const { hostedSession, sessionManager } = makeSession(projectRoot);
            /** @type {import('./hosted-session.js').ActiveExecutionWorkflow} */
            const workflow = {
                planName: "stable-plan",
                triageMeta: { classification: "FEATURE", worktreeId: "wt-stable" },
                executionAgent: "engineer",
                executionStarted: true,
                executionCwd: `${projectRoot}/worktrees/wt-stable`,
            };
            hostedSession.setActiveExecutionWorkflow(workflow);
            await switchActiveAgent(hostedSession, {
                agentName: "engineer",
                model: "claude-cli/sonnet",
                sessionManager,
            });

            const planBody = "# Stable Plan\n\nOnly one copy belongs in the transcript.";
            const failed = prepareRequestDispatch(sessionManager, {
                userRequest: planBody,
                dispatchKind: "plan_execution",
                backend: "claude-cli",
            });
            sessionManager.appendMessage({
                role: "user",
                timestamp: Date.now(),
                content: [{ type: "text", text: planBody }],
            });
            failRequestDispatch(sessionManager, failed, true);

            await switchActiveAgent(hostedSession, {
                agentName: "engineer",
                model: "runtime-command-fixture/fixture-model",
                forceRebuild: true,
                sessionManager,
            });
            await runActiveAgentTurn({
                hostedSession,
                agentName: "engineer",
                userRequest: planBody,
                sessionManager,
                dispatchKind: "plan_execution",
                resumePreviousRequest: true,
            });

            const transcript = sessionManager.getBranch()
                .filter((entry) => entry.type === "message")
                .flatMap((entry) =>
                    /** @type {{ message?: { content?: Array<{ type: string, text?: string }> } }} */ (entry)
                        .message?.content || []
                )
                .filter((block) => block.type === "text")
                .map((block) => block.text || "")
                .join("\n");
            assertEquals(transcript.split(planBody).length - 1, 1);
            assertEquals(transcript.split(BACKEND_CONTINUATION_REQUEST).length - 1, 1);
            assertEquals(hostedSession.getActiveExecutionWorkflow(), workflow);
            assertEquals(hostedSession.getActiveExecutionWorkflow()?.executionAgent, "engineer");
            assertEquals(hostedSession.getActiveExecutionWorkflow()?.executionCwd, workflow.executionCwd);
            const attempts = readRequestAttemptEntries(sessionManager);
            assertEquals(attempts.at(-2)?.requestId, failed.requestId);
            assertEquals(attempts.at(-2)?.backend, "pi");
            hostedSession.dispose();
        },
    );
});

test("switchActiveAgent releases planned workflow only when user authorized", async () => {
    await withRuntimeCommandFixture("agent-switch-release-planned-", async ({ projectRoot }) => {
        const { hostedSession, sessionManager } = makeSession(projectRoot);
        /** @type {Array<{ type?: string, message?: string }>} */
        const events = [];
        hostedSession.setEventSink((/** @type {{ type?: string, message?: string }} */ event) => events.push(event));
        await switchActiveAgent(hostedSession, { agentName: "engineer", sessionManager });
        hostedSession.setWorkflowPlanName("planned-release");
        hostedSession.setActiveExecutionWorkflow({
            planName: "planned-release",
            triageMeta: { classification: "PLANNED_CHANGE" },
            executionAgent: "engineer",
            executionStarted: true,
            executionAttemptStartedAtMs: 1,
        });

        await switchActiveAgent(hostedSession, { agentName: "planner", sessionManager });
        assertEquals(hostedSession.getActiveExecutionWorkflow()?.planName, "planned-release");

        await switchActiveAgent(hostedSession, { agentName: "planner", sessionManager, releaseActiveWorkflow: true });
        assertEquals(hostedSession.getActiveExecutionWorkflow(), null);
        assertEquals(hostedSession.getWorkflowContext()?.planName, "planned-release");
        assertEquals(
            events.some((event) =>
                event.type === RuntimeEventTypes.SYSTEM_STATUS && String(event.message || "").includes("/load-plan")
            ),
            true,
        );
        hostedSession.dispose();
    });
});

test("switchActiveAgent releases QUICK_FIX workflow with no-plan notice", async () => {
    await withRuntimeCommandFixture("agent-switch-release-quick-fix-", async ({ projectRoot }) => {
        const { hostedSession, sessionManager } = makeSession(projectRoot);
        /** @type {Array<{ type?: string, message?: string }>} */
        const events = [];
        hostedSession.setEventSink((/** @type {{ type?: string, message?: string }} */ event) => events.push(event));
        await switchActiveAgent(hostedSession, { agentName: "engineer", sessionManager });
        hostedSession.setActiveExecutionWorkflow({
            planName: "quick-fix",
            triageMeta: { classification: "QUICK_FIX" },
            executionAgent: "engineer",
            executionStarted: true,
            executionAttemptStartedAtMs: 1,
        });

        await switchActiveAgent(hostedSession, { agentName: "guide", sessionManager, releaseActiveWorkflow: true });

        assertEquals(hostedSession.getActiveExecutionWorkflow(), null);
        assertEquals(
            events.some((event) =>
                event.type === RuntimeEventTypes.SYSTEM_STATUS &&
                String(event.message || "").includes("There is no resumable Plan")
            ),
            true,
        );
        hostedSession.dispose();
    });
});

test("switchActiveAgent same-Agent user switch still releases workflow", async () => {
    await withRuntimeCommandFixture("agent-switch-release-same-agent-", async ({ projectRoot }) => {
        const { hostedSession, sessionManager } = makeSession(projectRoot);
        await switchActiveAgent(hostedSession, { agentName: "engineer", sessionManager });
        hostedSession.setActiveExecutionWorkflow({
            planName: "same-agent-plan",
            triageMeta: { classification: "PLANNED_CHANGE" },
            executionAgent: "engineer",
            executionStarted: true,
            executionAttemptStartedAtMs: 1,
        });

        await switchActiveAgent(hostedSession, { agentName: "engineer", sessionManager, releaseActiveWorkflow: true });

        assertEquals(hostedSession.getRootAgentName(), "engineer");
        assertEquals(hostedSession.getActiveExecutionWorkflow(), null);
        hostedSession.dispose();
    });
});

test("switchActiveAgent failed user-authorized switch preserves workflow", async () => {
    await withRuntimeCommandFixture("agent-switch-release-failure-", async ({ projectRoot }) => {
        const { hostedSession, sessionManager } = makeSession(projectRoot);
        await switchActiveAgent(hostedSession, { agentName: "engineer", sessionManager });
        hostedSession.setActiveExecutionWorkflow({
            planName: "failed-switch-plan",
            triageMeta: { classification: "PLANNED_CHANGE" },
            executionAgent: "engineer",
            executionStarted: true,
            executionAttemptStartedAtMs: 1,
        });

        await assertRejects(
            () =>
                switchActiveAgent(hostedSession, {
                    agentName: "planner",
                    model: "missing-provider/missing-model",
                    forceRebuild: true,
                    sessionManager,
                    releaseActiveWorkflow: true,
                }),
            Error,
            "Unknown invocation model override",
        );

        assertEquals(hostedSession.getRootAgentName(), "engineer");
        assertEquals(hostedSession.getActiveExecutionWorkflow()?.planName, "failed-switch-plan");
        hostedSession.dispose();
    });
});
