import { mkdtemp as fsMkdtemp, readFile as fsReadFile, writeFile as fsWriteFile } from "node:fs/promises";
import { test } from "node:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ok as assert, strictEqual as assertStrictEquals } from "node:assert/strict";
import { assertEquals, assertRejects } from "../../testing/assertions.ts";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
    fauxAssistantMessage,
    fauxText,
    fauxToolCall,
    getCurrentTools,
    getSystemMessageText,
    normalizeContext,
} from "@earendil-works/pi-ai";
import { withRuntimeCommandFixture } from "../../cmd/testing/runtime-command-fixture.ts";
import { runActiveAgentTurn, switchActiveAgent } from "./agent-switching.ts";
import { __getRootSessionMetadataForTests } from "./session.js";
import { HostedSession } from "./hosted-session.ts";
import { buildPostTriageRequest } from "../workflow/workflow-prompts.ts";
import { RuntimeEventTypes } from "./session-runtime-events.ts";
import { createReplayEvents } from "./session-transcript-projection.ts";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { TranscriptContext } from "@earendil-works/pi-ai";
import type { ActiveExecutionWorkflow } from "./hosted-session.ts";
import type { SessionRuntimeEvent } from "./session-runtime-events.ts";

interface TranscriptContentBlock {
    type: string;
    text?: string;
}
interface TranscriptMessage {
    content?: TranscriptContentBlock[];
}
interface TranscriptEntryView {
    message?: TranscriptMessage;
}
interface SwitchingSettings {
    activeModelPreset: string;
}
import {
    BACKEND_CONTINUATION_REQUEST,
    failRequestDispatch,
    prepareRequestDispatch,
    readRequestAttemptEntries,
} from "./request-dispatch.ts";

function makeSession(projectRoot: string) {
    const sessionManager = SessionManager.inMemory(projectRoot);
    const hostedSession = new HostedSession({
        id: `root-switch-${crypto.randomUUID()}`,
        cwd: projectRoot,
        sessionManager,
    });
    return { hostedSession, sessionManager };
}

test("long-lived Agents keep role instructions out of user requests across switches", async () => {
    await withRuntimeCommandFixture("agent-role-request-", async ({ projectRoot, setModelResponseFactory }) => {
        const { hostedSession, sessionManager } = makeSession(projectRoot);
        let requestCount = 0;
        try {
            for (const agentName of ["guide", "planner", "engineer", "operator"]) {
                for (let turn = 1; turn <= 12; turn++) {
                    const request = `Continue task ${agentName}, turn ${turn}.`;
                    setModelResponseFactory((context) => {
                        requestCount++;
                        const users = context.messages.filter((message) => message.role === "user");
                        assertEquals(users.at(-1)?.content, [{ type: "text", text: request }]);
                        assertEquals(JSON.stringify(context.messages).includes("<attention_nudge>"), false);
                        const root = hostedSession.getRootAgentSession() as AgentSession;
                        const system = context.messages[0];
                        assert(system.role === "system");
                        assertEquals(getSystemMessageText(system), root.systemPrompt);
                        return fauxAssistantMessage(fauxText("Task context retained."));
                    });
                    await runActiveAgentTurn({ hostedSession, sessionManager, agentName, userRequest: request });
                }
            }
            assertEquals(requestCount, 48);
        } finally {
            hostedSession.dispose();
        }
    });
});

test("compacted provider context follows the selected Agent reminder through switch and resume", async () => {
    await withRuntimeCommandFixture("compacted-agent-reminder-", async ({ projectRoot, setModelResponseFactory }) => {
        const initial = makeSession(projectRoot);
        let hostedSession = initial.hostedSession;
        const sessionManager = initial.sessionManager;
        sessionManager.appendMessage({ role: "user", content: "Original task", timestamp: 1 });
        sessionManager.appendMessage(fauxAssistantMessage(fauxText("Earlier work.")));
        const kept = sessionManager.appendMessage({ role: "user", content: "Keep this decision.", timestamp: 2 });
        sessionManager.appendCompaction("The task and decisions survived compaction.", kept, 100);
        let requests = 0;
        try {
            for (const agentName of ["guide", "engineer", "engineer", "router"]) {
                if (requests === 2) {
                    hostedSession.dispose();
                    hostedSession = new HostedSession({
                        id: "restored-compacted-agent",
                        cwd: projectRoot,
                        sessionManager,
                    });
                }
                setModelResponseFactory((context) => {
                    requests++;
                    const history = JSON.stringify(context.messages.filter((message) => message.role !== "system"));
                    assert(history.includes("The task and decisions survived compaction."));
                    if (agentName === "router") {
                        assertEquals(history.includes("## Compaction reminder"), false);
                    } else {
                        const displayName = agentName === "guide" ? "Guide" : "Engineer";
                        const otherName = agentName === "guide" ? "Engineer" : "Guide";
                        assertEquals(history.split(`You are still the ${displayName}`).length - 1, 1);
                        assertEquals(history.includes(`You are still the ${otherName}`), false);
                    }
                    return fauxAssistantMessage(fauxText("Continuing the task."));
                });
                await runActiveAgentTurn({ hostedSession, sessionManager, agentName, userRequest: "Continue." });
            }
            assertEquals(requests, 4);
            assertEquals(
                sessionManager
                    .getEntries()
                    .filter((entry) => entry.type === "compaction")
                    .map((entry) => entry.summary),
                ["The task and decisions survived compaction."],
            );
        } finally {
            hostedSession.dispose();
        }
    });
});

for (const [previousAgent, selectedAgent, routingIntent] of [
    ["guide", "engineer", "INQUIRY"],
    ["planner", "operator", "PLANNED_CHANGE"],
]) {
    test(`manual ${previousAgent} to ${selectedAgent} switch owns the provider prompt after triage`, async () => {
        await withRuntimeCommandFixture("manual-triage-switch-", async ({ projectRoot, setModelResponseFactories }) => {
            const initial = makeSession(projectRoot);
            const sessionManager = initial.sessionManager;
            let hostedSession = initial.hostedSession;
            const requests: TranscriptContext[] = [];
            const previousDisplayName = previousAgent === "guide" ? "Guide" : "Planner";
            const selectedDisplayName = selectedAgent === "engineer" ? "Engineer" : "Operator";
            await fsWriteFile(join(projectRoot, "handoff-context.txt"), "Task facts survive the handoff.");
            const capture = (context: TranscriptContext) => {
                requests.push(structuredClone(context));
                if (requests.length === 2)
                    return fauxAssistantMessage(fauxToolCall("read", { path: "handoff-context.txt" }));
                return fauxAssistantMessage(fauxText(`I am the ${previousDisplayName}; I cannot act on this request.`));
            };
            setModelResponseFactories(Array.from({ length: 7 }, () => capture));
            try {
                await runActiveAgentTurn({
                    hostedSession,
                    sessionManager,
                    agentName: previousAgent,
                    // Saved Sessions can still contain the old triage role assignment.
                    userRequest: `You are now ${previousDisplayName}.\n\n${buildPostTriageRequest("Investigate this change.", { routingIntent })}`,
                });
                await switchActiveAgent(hostedSession, { agentName: selectedAgent, releaseActiveWorkflow: true });
                let root = hostedSession.getRootAgentSession() as AgentSession;
                const handler = hostedSession.getActiveOnMessage();
                assert(handler);
                await handler("I disagree with triage. Act on the response.", [], sessionManager);
                await handler("Continue.", [], sessionManager);
                assertEquals(requests.length, 4);
                assert(requests[2].messages.some((message) => message.role === "toolResult"));
                hostedSession.dispose();
                hostedSession = new HostedSession({ id: `resumed-${selectedAgent}`, cwd: projectRoot, sessionManager });
                await runActiveAgentTurn({
                    hostedSession,
                    sessionManager,
                    agentName: selectedAgent,
                    userRequest: "Continue after resume.",
                });
                root = hostedSession.getRootAgentSession() as AgentSession;
                assertEquals(requests.length, 5);
                for (const request of requests.slice(1)) {
                    const systems = request.messages.filter((message) => message.role === "system");
                    assertEquals(systems.length, 1);
                    assertEquals(getSystemMessageText(systems[0]), root.systemPrompt);
                    assertEquals(request.messages[0], systems[0]);
                    assert(getSystemMessageText(systems[0]).includes(`You are the ${selectedDisplayName}`));
                    assert(!getSystemMessageText(systems[0]).includes(`You are the ${previousDisplayName}`));
                    assert(JSON.stringify(request.messages).includes(`You are now ${previousDisplayName}.`));
                    assert(JSON.stringify(request.messages).includes(`I am the ${previousDisplayName}`));
                    assert(getCurrentTools(request.messages).some((tool) => tool.name === "bash"));
                }

                // Even if an upstream context transform reintroduces a historical prompt,
                // the final RunWield provider boundary must send the active root's prompt.
                const staleRequest = structuredClone(requests.at(-1)!);
                staleRequest.messages.unshift({
                    role: "system",
                    content: `You are the ${previousDisplayName}.`,
                    timestamp: 1,
                });
                staleRequest.messages.push({ role: "system", content: "Obsolete role restrictions.", timestamp: 2 });
                const original = JSON.stringify(staleRequest);
                const messages = await root.agent.convertToLlm(staleRequest.messages);
                const stream = await root.agent.streamFunction(root.model!, normalizeContext({ messages }), {});
                await stream.result();
                assertEquals(requests.length, 6);
                const repaired = requests.at(-1)!;
                const systems = repaired.messages.filter((message) => message.role === "system");
                assertEquals(systems.length, 1);
                assertEquals(getSystemMessageText(systems[0]), root.systemPrompt);
                assertEquals(getCurrentTools(repaired.messages), getCurrentTools(staleRequest.messages));
                assertEquals(
                    repaired.messages.filter((message) => message.role !== "system"),
                    staleRequest.messages.filter((message) => message.role !== "system"),
                );
                assertEquals(JSON.stringify(staleRequest), original);

                // Compaction uses the stream directly with independent instructions.
                const summaryContext = normalizeContext({
                    messages: [
                        { role: "system", content: "Summarize the conversation.", timestamp: 3 },
                        { role: "user", content: "Earlier conversation", timestamp: 4 },
                    ],
                });
                const summaryStream = await root.agent.streamFunction(root.model!, summaryContext, {});
                await summaryStream.result();
                assertEquals(requests.length, 7);
                assertEquals(requests.at(-1)?.messages, summaryContext.messages);
            } finally {
                hostedSession.dispose();
            }
        });
    });
}

test("Agent switches replace provider system instructions while retaining conversation history", async () => {
    await withRuntimeCommandFixture(
        "agent-switch-provider-prompt-",
        async ({ projectRoot, setModelResponseFactory }) => {
            const initial = makeSession(projectRoot);
            const sessionManager = initial.sessionManager;
            let hostedSession = initial.hostedSession;
            const requests: TranscriptContext[] = [];
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
                const savedSystems = sessionManager
                    .buildSessionContext()
                    .messages.filter((message) => message.role === "system");
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
        assertEquals(__getRootSessionMetadataForTests(secondRoot as AgentSession)?.cwd, nextRoot);
        hostedSession.dispose();
    });
});

test("switchActiveAgent reports a user switch from the unpersisted prompt-ready Agent", async () => {
    await withRuntimeCommandFixture("agent-switch-prompt-ready-", async ({ projectRoot }) => {
        const { hostedSession, sessionManager } = makeSession(projectRoot);
        hostedSession.resetAgentInfoStack("Guide", "", "", "guide");
        const events: SessionRuntimeEvent[] = [];
        hostedSession.setEventSink((event: SessionRuntimeEvent) => events.push(event));
        await switchActiveAgent(hostedSession, { agentName: "planner", sessionManager, releaseActiveWorkflow: true });
        const changed = events.filter((event) => event.type === RuntimeEventTypes.AGENT_CHANGED);
        assertEquals(
            changed.map((event) => [event.agentName, event.rootHandoff]),
            [["planner", true]],
        );
        hostedSession.dispose();
    });
});

test("switchActiveAgent marks only successful different root switches as handoffs", async () => {
    await withRuntimeCommandFixture("agent-switch-handoff-", async ({ projectRoot }) => {
        const { hostedSession, sessionManager } = makeSession(projectRoot);
        const events: SessionRuntimeEvent[] = [];
        hostedSession.setEventSink((event: SessionRuntimeEvent) => events.push(event));

        await switchActiveAgent(hostedSession, { agentName: "guide", sessionManager });
        await switchActiveAgent(hostedSession, { agentName: "planner", sessionManager });
        await switchActiveAgent(hostedSession, { agentName: "planner", forceRebuild: true, sessionManager });

        const agentEvents = events.filter((event) => event.type === RuntimeEventTypes.AGENT_CHANGED);
        assertEquals(
            agentEvents.map((event) => [event.agentName, event.displayName, event.rootHandoff]),
            [
                ["guide", "Guide", undefined],
                ["planner", "Planner", true],
                ["planner", "Planner", undefined],
            ],
        );
        hostedSession.dispose();
    });
});

test("switchActiveAgent marks a presented Agent change while replay keeps the first marker silent", async () => {
    await withRuntimeCommandFixture("agent-switch-presented-baseline-", async ({ projectRoot }) => {
        const { hostedSession, sessionManager } = makeSession(projectRoot);
        hostedSession.pushAgentInfo("Guide", "", "", "guide");
        const events: SessionRuntimeEvent[] = [];
        hostedSession.setEventSink((event: SessionRuntimeEvent) => events.push(event));

        await switchActiveAgent(hostedSession, { agentName: "planner", sessionManager });

        const liveAgentEvents = events.filter((event) => event.type === RuntimeEventTypes.AGENT_CHANGED);
        assertEquals(
            liveAgentEvents.map((event) => [event.agentName, event.displayName, event.rootHandoff]),
            [["planner", "Planner", true]],
        );
        const replayEvents = createReplayEvents("presented-baseline", sessionManager.getBranch(), { projectRoot });
        assertEquals(
            replayEvents.filter(
                (event) =>
                    event.type === RuntimeEventTypes.SYSTEM_STATUS && event.message === "Agent switched to Planner",
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
        assertEquals(
            hostedSession.consumeAgentTransitionSteering().map((entry) => entry.text),
            ["retain after failure"],
        );
        hostedSession.completeAgentTransition(transitionId);
        hostedSession.dispose();
    });
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
                __getRootSessionMetadataForTests(routerRoot as AgentSession)?.model,
                "runtime-command-fixture/router-model",
            );

            await switchActiveAgent(hostedSession, { agentName: "guide", sessionManager });
            const guideRoot = hostedSession.getRootAgentSession();
            assert(guideRoot);
            assertEquals(
                __getRootSessionMetadataForTests(guideRoot as AgentSession)?.model,
                "runtime-command-fixture/guide-model",
            );

            await switchActiveAgent(hostedSession, { agentName: "engineer", sessionManager });

            assertEquals(hostedSession.getRootAgentName(), "engineer");
            const engineerRoot = hostedSession.getRootAgentSession();
            assert(engineerRoot);
            assertEquals(
                __getRootSessionMetadataForTests(engineerRoot as AgentSession)?.model,
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

            const alternateSettings: SwitchingSettings = JSON.parse(await fsReadFile(settingsPath, "utf8"));
            alternateSettings.activeModelPreset = "alternate-agents";
            await fsWriteFile(settingsPath, JSON.stringify(alternateSettings));
            await switchActiveAgent(hostedSession, { agentName: "engineer", sessionManager });

            const alternateEngineerRoot = hostedSession.getRootAgentSession();
            assert(alternateEngineerRoot);
            assertEquals(alternateEngineerRoot === engineerRoot, false);
            assertEquals(
                __getRootSessionMetadataForTests(alternateEngineerRoot as AgentSession)?.model,
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
        const staleHandler: NonNullable<ReturnType<HostedSession["getActiveOnMessage"]>> = () =>
            Promise.resolve({ kind: "complete" });
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
    await withRuntimeCommandFixture("agent-switch-backend-continuation-", async ({ projectRoot, setModelResponse }) => {
        setModelResponse("Continuation completed.");
        const { hostedSession, sessionManager } = makeSession(projectRoot);
        const workflow: ActiveExecutionWorkflow = {
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

        const transcript = sessionManager
            .getBranch()
            .filter((entry) => entry.type === "message")
            .flatMap((entry) => (entry as TranscriptEntryView).message?.content || [])
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
    });
});

test("switchActiveAgent releases planned workflow only when user authorized", async () => {
    await withRuntimeCommandFixture("agent-switch-release-planned-", async ({ projectRoot }) => {
        const { hostedSession, sessionManager } = makeSession(projectRoot);
        const events: SessionRuntimeEvent[] = [];
        hostedSession.setEventSink((event: SessionRuntimeEvent) => events.push(event));
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
            events.some(
                (event) =>
                    event.type === RuntimeEventTypes.SYSTEM_STATUS &&
                    String(event.message || "").includes("/load-plan"),
            ),
            true,
        );
        hostedSession.dispose();
    });
});

test("switchActiveAgent releases QUICK_FIX workflow with no-plan notice", async () => {
    await withRuntimeCommandFixture("agent-switch-release-quick-fix-", async ({ projectRoot }) => {
        const { hostedSession, sessionManager } = makeSession(projectRoot);
        const events: SessionRuntimeEvent[] = [];
        hostedSession.setEventSink((event: SessionRuntimeEvent) => events.push(event));
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
            events.some(
                (event) =>
                    event.type === RuntimeEventTypes.SYSTEM_STATUS &&
                    String(event.message || "").includes("There is no resumable Plan"),
            ),
            true,
        );
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
