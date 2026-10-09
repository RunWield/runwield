import { assertEquals, assertStringIncludes } from "@std/assert";
import {
    fauxAssistantMessage,
    fauxText,
    fauxToolCall,
    getCurrentSystemPrompt,
    type ToolResultMessage,
} from "@earendil-works/pi-ai";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { withRuntimeCommandFixture } from "../../cmd/testing/runtime-command-fixture.ts";
import { loadPlan, savePlan } from "../../plan-store.js";
import { git } from "../git-test-fixture.ts";
import { HostedSession } from "../session/hosted-session.js";
import { listPendingTaskCompletions } from "../session/task-completion-session.ts";
import { setCustomSetting } from "../settings.js";
import type { SessionRuntimeEvent } from "../session/session-runtime-events.js";
import type { RuntimeInteractionRequest, RuntimeInteractionResponse } from "../session/session-runtime-interactions.js";
import { dispatchPostTriage, type DispatchPostTriageArgs, readLatestTriageOutcome } from "./orchestrator.ts";
import { getWorkflowMetricsFilePath } from "./metrics.js";
import { publishWorkflowToolEvent } from "./workflow-tool-events.ts";
import type { LocalCIPort, LocalCIResult } from "./validation-local-ci.ts";

interface SessionFixture {
    events: SessionRuntimeEvent[];
    hostedSession: HostedSession;
    sessionManager: SessionManager;
}

interface LocalCIFixture {
    calls: string[];
    port: LocalCIPort;
}

type InteractionHandler = (request: RuntimeInteractionRequest) => RuntimeInteractionResponse;

function createSessionFixture(projectRoot: string, interaction?: InteractionHandler): SessionFixture {
    const sessionManager = SessionManager.inMemory(projectRoot);
    const hostedSession = new HostedSession({
        id: `orchestrator-${crypto.randomUUID()}`,
        cwd: projectRoot,
        interactionAdapter: {
            requestInteraction: (request) =>
                interaction?.(request) ?? { outcome: "canceled", message: "Fixture supplied no interaction answer." },
        },
    });
    // HostedSession's legacy minimal-manager JSDoc is wider than Pi's concrete
    // manager signature; this is the real runtime manager used in production.
    hostedSession.setRootSessionManager(sessionManager);
    const events: SessionRuntimeEvent[] = [];
    hostedSession.setEventSink((event: SessionRuntimeEvent) => events.push(event));
    return { events, hostedSession, sessionManager };
}

function defineLocalCIFixture(results: LocalCIResult[] = []): LocalCIFixture {
    const remaining = [...results];
    const calls: string[] = [];
    return {
        calls,
        port: {
            run: ({ cwd }) => {
                calls.push(cwd);
                const result = remaining.shift();
                if (!result) throw new Error("Local CI fixture was called unexpectedly or exhausted");
                return Promise.resolve(result);
            },
        },
    };
}

function taskCompleted(summary: string): ReturnType<typeof fauxAssistantMessage> {
    return fauxAssistantMessage(fauxToolCall("task_completed", { message: summary }));
}

function publishPlanOutcome(
    hostedSession: HostedSession,
    outcome: "approved_execute" | "approved_decompose",
    planName: string,
): void {
    publishWorkflowToolEvent({
        hostedSession,
        toolCallId: `plan-${crypto.randomUUID()}`,
        kind: "plan_written",
        payload: { outcome, planName },
    });
}

function triageToolResult(details: DispatchPostTriageArgs["triage"]): ToolResultMessage<
    DispatchPostTriageArgs["triage"]
> {
    return {
        role: "toolResult",
        toolCallId: crypto.randomUUID(),
        toolName: "triage_report",
        content: [{ type: "text", text: "Triage recorded." }],
        details,
        isError: false,
        timestamp: Date.now(),
    };
}

async function initializeGitProject(projectRoot: string): Promise<void> {
    await git(projectRoot, ["init", "-b", "main"]);
    await git(projectRoot, ["config", "user.email", "test@example.com"]);
    await git(projectRoot, ["config", "user.name", "RunWield Test"]);
    await Deno.writeTextFile(`${projectRoot}/README.md`, "fixture\n");
    await git(projectRoot, ["add", "."]);
    await git(projectRoot, ["commit", "-m", "fixture: initial project"]);
}

Deno.test("readLatestTriageOutcome normalizes the latest current-turn report", () => {
    const messages: AgentMessage[] = [
        triageToolResult({
            routingIntent: "QUICK_FIX",
            complexity: "LOW",
            summary: "old",
        }),
        triageToolResult({
            routingIntent: "FEATURE",
            classification: "FEATURE",
            complexity: "MEDIUM",
            summary: "current",
            sessionName: "current feature",
        }),
    ];

    assertEquals(readLatestTriageOutcome(messages, 1), {
        routingIntent: "PLANNED_CHANGE",
        classification: "PLANNED_CHANGE",
        complexity: "MEDIUM",
        summary: "current",
        sessionName: "current feature",
    });
});

Deno.test("readLatestTriageOutcome normalizes a report without affectedPaths", () => {
    const messages: AgentMessage[] = [
        triageToolResult({
            routingIntent: "PLANNED_CHANGE",
            classification: "PLANNED_CHANGE",
            complexity: "HIGH",
            summary: "planned without paths",
            sessionName: "plan without paths",
        }),
    ];

    assertEquals(readLatestTriageOutcome(messages), {
        routingIntent: "PLANNED_CHANGE",
        classification: "PLANNED_CHANGE",
        complexity: "HIGH",
        summary: "planned without paths",
        sessionName: "plan without paths",
    });
});

Deno.test("readLatestTriageOutcome ignores reports before the current turn", () => {
    const messages: AgentMessage[] = [
        triageToolResult({
            classification: "OPERATION",
            complexity: "LOW",
            summary: "old operation",
        }),
        fauxAssistantMessage(fauxText("No triage report this turn.")),
    ];

    assertEquals(readLatestTriageOutcome(messages, 1), null);
});

Deno.test("dispatchPostTriage routes conversational intents through real Agent sessions", async () => {
    await withRuntimeCommandFixture("orchestrator-conversation-", async ({ projectRoot, setModelMessages }) => {
        await setCustomSetting("workflowMetrics", true, "project", projectRoot);
        setModelMessages([
            fauxAssistantMessage(fauxText("Guide answer.")),
            fauxAssistantMessage(fauxText("Ideator response.")),
        ]);
        const guide = createSessionFixture(projectRoot);
        const ideator = createSessionFixture(projectRoot);
        const ci = defineLocalCIFixture();

        await dispatchPostTriage({
            hostedSession: guide.hostedSession,
            triage: {
                routingIntent: "INQUIRY",
                complexity: "LOW",
                summary: "answer a question",
            },
            userRequest: "Where is routing configured?",
            images: [],
            sessionManager: guide.sessionManager,
            localCI: ci.port,
        });
        await dispatchPostTriage({
            hostedSession: ideator.hostedSession,
            triage: {
                routingIntent: "IDEATION",
                complexity: "LOW",
                summary: "explore an idea",
            },
            userRequest: "Explore provider options.",
            images: [],
            sessionManager: ideator.sessionManager,
            localCI: ci.port,
        });

        assertEquals([guide.hostedSession.getRootAgentName(), ideator.hostedSession.getRootAgentName()], [
            "guide",
            "ideator",
        ]);
        assertEquals(ci.calls, []);
        const metrics = (await Deno.readTextFile(getWorkflowMetricsFilePath(projectRoot))).trim().split("\n").map(
            (line) => JSON.parse(line),
        );
        assertEquals(
            metrics.filter((metric) => metric.event === "dispatch_selected").map((metric) => metric.agentName),
            ["guide", "ideator"],
        );
        guide.hostedSession.dispose();
        ideator.hostedSession.dispose();
    });
});

Deno.test("OPERATION completion stays with Operator without validation", async () => {
    await withRuntimeCommandFixture("orchestrator-operation-", async ({ projectRoot, setModelMessages }) => {
        setModelMessages([taskCompleted("Repository status inspected.")]);
        const fixture = createSessionFixture(projectRoot);
        const ci = defineLocalCIFixture();

        await dispatchPostTriage({
            hostedSession: fixture.hostedSession,
            triage: {
                routingIntent: "OPERATION",
                complexity: "LOW",
                summary: "show status",
            },
            userRequest: "Show git status.",
            images: [],
            sessionManager: fixture.sessionManager,
            localCI: ci.port,
        });

        assertEquals(fixture.hostedSession.getRootAgentName(), "operator");
        assertEquals(ci.calls, []);
        fixture.hostedSession.dispose();
    });
});

Deno.test("QUICK_FIX completion runs real Mechanical Validation around the CI port", async () => {
    await withRuntimeCommandFixture("orchestrator-quick-fix-", async ({ projectRoot, setModelMessages }) => {
        await initializeGitProject(projectRoot);
        setModelMessages([
            taskCompleted("Updated the settings save action."),
            fauxAssistantMessage(fauxToolCall("manual_qa_completed", {
                checklistMarkdown: "Manual verification steps\n- [ ] Save settings and reload.",
            })),
        ]);
        const fixture = createSessionFixture(projectRoot);
        const ci = defineLocalCIFixture([{ kind: "completed", exitCode: 0, output: "ok" }]);

        await dispatchPostTriage({
            hostedSession: fixture.hostedSession,
            triage: {
                routingIntent: "QUICK_FIX",
                complexity: "LOW",
                summary: "small fix",
                sessionName: "settings-save",
            },
            userRequest: "Fix settings persistence.",
            images: [],
            sessionManager: fixture.sessionManager,
            localCI: ci.port,
        });

        assertEquals(ci.calls, [projectRoot]);
        assertEquals(fixture.hostedSession.getActiveExecutionWorkflow()?.triageMeta?.classification, "QUICK_FIX");
        assertEquals(fixture.hostedSession.getRootAgentName(), "engineer");
        assertEquals(listPendingTaskCompletions(fixture.hostedSession), []);
        assertEquals(
            fixture.sessionManager.getBranch().some((entry) =>
                entry.type === "custom" && entry.customType === "runwield.manual_qa_checklist"
            ),
            true,
        );
        fixture.hostedSession.dispose();
    });
});

Deno.test("QUICK_FIX keeps its real workflow when Engineer stops before task_completed", async () => {
    await withRuntimeCommandFixture("orchestrator-quick-fix-paused-", async ({ projectRoot, setModelMessages }) => {
        await initializeGitProject(projectRoot);
        setModelMessages([fauxAssistantMessage(fauxText("I need another turn."))]);
        const fixture = createSessionFixture(projectRoot);
        const ci = defineLocalCIFixture();

        await dispatchPostTriage({
            hostedSession: fixture.hostedSession,
            triage: {
                routingIntent: "QUICK_FIX",
                complexity: "LOW",
                summary: "small fix",
            },
            userRequest: "Fix settings persistence.",
            images: [],
            sessionManager: fixture.sessionManager,
            localCI: ci.port,
        });

        assertEquals(fixture.hostedSession.getActiveExecutionWorkflow()?.planName, "quick-fix");
        assertEquals(fixture.hostedSession.getActiveExecutionWorkflow()?.executionAgent, "engineer");
        assertEquals(ci.calls, []);
        fixture.hostedSession.dispose();
    });
});

Deno.test("non-Git QUICK_FIX cancellation stops before creating an Agent session", async () => {
    await withRuntimeCommandFixture("orchestrator-quick-fix-cancel-", async ({ projectRoot }) => {
        const interactions: RuntimeInteractionRequest[] = [];
        const fixture = createSessionFixture(projectRoot, (request) => {
            interactions.push(request);
            return { outcome: "canceled" };
        });
        const ci = defineLocalCIFixture();

        await dispatchPostTriage({
            hostedSession: fixture.hostedSession,
            triage: {
                routingIntent: "QUICK_FIX",
                complexity: "LOW",
                summary: "small fix",
            },
            userRequest: "Fix settings persistence.",
            images: [],
            sessionManager: fixture.sessionManager,
            localCI: ci.port,
        });

        assertEquals(interactions.map((request) => request.type), ["select"]);
        assertEquals(fixture.hostedSession.getRootAgentName(), null);
        assertEquals(fixture.hostedSession.getActiveExecutionWorkflow(), null);
        assertEquals(ci.calls, []);
        fixture.hostedSession.dispose();
    });
});

Deno.test("planned work with no Plan declaration stays with the real Planner", async () => {
    await withRuntimeCommandFixture("orchestrator-planning-paused-", async ({ projectRoot, setModelMessages }) => {
        setModelMessages([fauxAssistantMessage(fauxText("I need more requirements before writing the Plan."))]);
        const fixture = createSessionFixture(projectRoot);
        const ci = defineLocalCIFixture();

        await dispatchPostTriage({
            hostedSession: fixture.hostedSession,
            triage: {
                routingIntent: "PLANNED_CHANGE",
                classification: "PLANNED_CHANGE",
                complexity: "MEDIUM",
                summary: "plan a feature",
            },
            userRequest: "Build the feature.",
            images: [],
            sessionManager: fixture.sessionManager,
            localCI: ci.port,
        });

        assertEquals(fixture.hostedSession.getRootAgentName(), "planner");
        assertEquals(await Deno.stat(`${projectRoot}/docs/plans`).then((entry) => entry.isDirectory), true);
        assertEquals(ci.calls, []);
        fixture.hostedSession.dispose();
    });
});

Deno.test("Router-to-Planner dispatch sends Planner system instructions despite Router transcript history", async () => {
    await withRuntimeCommandFixture(
        "orchestrator-planner-prompt-",
        async ({ projectRoot, setModelResponseFactory }) => {
            let systemPrompt = "";
            let modelMessages = "";
            setModelResponseFactory((context) => {
                systemPrompt = getCurrentSystemPrompt(context.messages);
                modelMessages = JSON.stringify(context.messages);
                return fauxAssistantMessage(fauxText("I need more requirements before writing the Plan."));
            });
            const fixture = createSessionFixture(projectRoot);
            fixture.sessionManager.appendMessage({
                role: "assistant",
                content: [{ type: "text", text: "I am the Router. My only job is routing." }],
                api: "runtime-command-faux",
                provider: "runtime-command-fixture",
                model: "fixture-model",
                usage: {
                    input: 0,
                    output: 0,
                    cacheRead: 0,
                    cacheWrite: 0,
                    totalTokens: 0,
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
                },
                stopReason: "stop",
                timestamp: Date.now(),
            });

            try {
                await dispatchPostTriage({
                    hostedSession: fixture.hostedSession,
                    triage: {
                        routingIntent: "PLANNED_CHANGE",
                        classification: "PLANNED_CHANGE",
                        complexity: "MEDIUM",
                        summary: "plan a feature",
                    },
                    userRequest: "Build the feature.",
                    images: [],
                    sessionManager: fixture.sessionManager,
                    localCI: defineLocalCIFixture().port,
                });

                assertStringIncludes(systemPrompt, "You are the Planner");
                assertEquals(systemPrompt.includes("Your ONLY job is to identify the Routing Intent"), false);
                assertStringIncludes(modelMessages, "I am the Router. My only job is routing.");
                assertStringIncludes(modelMessages, "You are now Planner.");
                assertStringIncludes(modelMessages, "previous RunWield Agent");
                assertStringIncludes(modelMessages, "## Triage Report");
            } finally {
                fixture.hostedSession.dispose();
            }
        },
    );
});

Deno.test("PROJECT approval runs the real readiness transition and Slicer", async () => {
    await withRuntimeCommandFixture("orchestrator-project-", async ({ projectRoot, setModelMessages }) => {
        await savePlan(projectRoot, "epic-a", "# Epic A", {
            classification: "PROJECT",
            complexity: "HIGH",
            summary: "Epic A",
            affectedPaths: ["src/project.ts"],
            status: "ready_for_decomposition",
        });
        const fixture = createSessionFixture(projectRoot, (request) => {
            if (request.type !== "plan_review") return { outcome: "canceled" };
            return {
                outcome: "accepted",
                _meta: { approved: true, approvalAction: "decompose" },
            };
        });
        setModelMessages([
            fauxAssistantMessage(fauxText("Plan submitted for decomposition.")),
            fauxAssistantMessage(fauxText("I am ready to decompose this Epic.")),
        ]);
        publishPlanOutcome(fixture.hostedSession, "approved_decompose", "epic-a");
        const ci = defineLocalCIFixture();

        await dispatchPostTriage({
            hostedSession: fixture.hostedSession,
            triage: {
                routingIntent: "PROJECT",
                classification: "PROJECT",
                complexity: "HIGH",
                summary: "Epic A",
            },
            userRequest: "Design the project.",
            images: [],
            sessionManager: fixture.sessionManager,
            localCI: ci.port,
        });

        assertEquals((await loadPlan(projectRoot, "epic-a"))?.attrs.status, "ready_for_decomposition");
        assertEquals(fixture.hostedSession.getRootAgentName(), "slicer");
        assertEquals(ci.calls, []);
        fixture.hostedSession.dispose();
    });
});

Deno.test("approved planned work executes through real lifecycle machinery and pauses with Engineer", async () => {
    await withRuntimeCommandFixture("orchestrator-feature-", async ({ projectRoot, setModelMessages }) => {
        await savePlan(projectRoot, "feature-a", "# Feature A", {
            classification: "PLANNED_CHANGE",
            complexity: "MEDIUM",
            summary: "Feature A",
            affectedPaths: ["src/feature.ts"],
            status: "ready_for_work",
            executionAgent: "engineer",
        });
        const interactions: RuntimeInteractionRequest[] = [];
        const fixture = createSessionFixture(projectRoot, (request) => {
            interactions.push(request);
            if (request.type === "plan_review") {
                return { outcome: "accepted", _meta: { approved: true, approvalAction: "run" } };
            }
            if (request.type === "select") return { outcome: "selected", value: "proceed" };
            return { outcome: "canceled" };
        });
        setModelMessages([
            fauxAssistantMessage(fauxText("Plan submitted for execution.")),
            fauxAssistantMessage(fauxText("Execution is paused before completion.")),
        ]);
        publishPlanOutcome(fixture.hostedSession, "approved_execute", "feature-a");
        const ci = defineLocalCIFixture();

        await dispatchPostTriage({
            hostedSession: fixture.hostedSession,
            triage: {
                routingIntent: "PLANNED_CHANGE",
                classification: "PLANNED_CHANGE",
                complexity: "MEDIUM",
                summary: "Feature A",
            },
            userRequest: "Build Feature A.",
            images: [],
            sessionManager: fixture.sessionManager,
            localCI: ci.port,
        });

        const plan = await loadPlan(projectRoot, "feature-a");
        assertEquals(plan?.attrs.status, "in_progress");
        assertEquals(plan?.attrs.executionMode, "non_git_in_place");
        assertEquals(fixture.hostedSession.getRootAgentName(), "engineer");
        assertEquals(fixture.hostedSession.getActiveExecutionWorkflow()?.planName, "feature-a");
        assertEquals(interactions.map((request) => request.type), ["select"]);
        assertEquals(ci.calls, []);
        fixture.hostedSession.dispose();
    });
});

Deno.test("completed planned work runs the real validation lifecycle around external ports", async () => {
    await withRuntimeCommandFixture(
        "orchestrator-feature-validated-",
        async ({ projectRoot, setModelMessages }) => {
            await Deno.mkdir(`${projectRoot}/.wld`, { recursive: true });
            await Deno.writeTextFile(
                `${projectRoot}/.wld/settings.json`,
                JSON.stringify({ codereview: "none", workRecords: { autoGenerateOnPlanCompletion: false } }),
            );
            await savePlan(projectRoot, "feature-validated", "# Validated Feature", {
                classification: "PLANNED_CHANGE",
                complexity: "MEDIUM",
                summary: "Validated Feature",
                affectedPaths: ["implemented.txt"],
                status: "ready_for_work",
                executionAgent: "engineer",
            });
            const fixture = createSessionFixture(projectRoot, (request) => {
                if (request.type === "plan_review") {
                    return { outcome: "accepted", _meta: { approved: true, approvalAction: "run" } };
                }
                if (request.type === "select") return { outcome: "selected", value: "proceed" };
                return { outcome: "canceled" };
            });
            setModelMessages([
                fauxAssistantMessage(fauxText("Plan submitted for execution.")),
                fauxAssistantMessage(fauxToolCall("write", {
                    path: "implemented.txt",
                    content: "implemented\n",
                })),
                taskCompleted("Implemented and checked the fixture feature."),
                fauxAssistantMessage(fauxToolCall("manual_qa_completed", {
                    checklistMarkdown: "Manual verification steps\n- [ ] Inspect implemented.txt.",
                })),
            ]);
            publishPlanOutcome(fixture.hostedSession, "approved_execute", "feature-validated");
            const ci = defineLocalCIFixture([{ kind: "completed", exitCode: 0, output: "fixture CI passed" }]);

            const result = await dispatchPostTriage({
                hostedSession: fixture.hostedSession,
                triage: {
                    routingIntent: "PLANNED_CHANGE",
                    classification: "PLANNED_CHANGE",
                    complexity: "MEDIUM",
                    summary: "Validated Feature",
                },
                userRequest: "Build and validate the feature.",
                images: [],
                sessionManager: fixture.sessionManager,
                localCI: ci.port,
            });

            assertEquals(result?.kind, "verified");
            assertEquals((await loadPlan(projectRoot, "feature-validated"))?.attrs.status, "verified");
            assertEquals(await Deno.readTextFile(`${projectRoot}/implemented.txt`), "implemented\n");
            assertEquals(ci.calls, [projectRoot]);
            assertEquals(
                fixture.sessionManager.getBranch().some((entry) =>
                    entry.type === "custom" && entry.customType === "runwield.manual_qa_checklist"
                ),
                true,
            );
            fixture.hostedSession.dispose();
        },
    );
});

Deno.test("Router session names are persisted and emitted before specialist dispatch", async () => {
    await withRuntimeCommandFixture("orchestrator-session-name-", async ({ projectRoot, setModelMessages }) => {
        setModelMessages([fauxAssistantMessage(fauxText("Guide answer."))]);
        const fixture = createSessionFixture(projectRoot);
        const ci = defineLocalCIFixture();

        await dispatchPostTriage({
            hostedSession: fixture.hostedSession,
            triage: {
                routingIntent: "INQUIRY",
                complexity: "LOW",
                summary: "question",
                sessionName: "terminal titles",
            },
            userRequest: "How should titles work?",
            images: [],
            sessionManager: fixture.sessionManager,
            localCI: ci.port,
        });

        assertEquals(fixture.sessionManager.getSessionName(), "terminal titles");
        const renamed = fixture.events.find((event) => event.type === "session_renamed");
        assertEquals(renamed?.type === "session_renamed" ? renamed.name : null, "terminal titles");
        assertEquals(fixture.hostedSession.getRootAgentName(), "guide");
        fixture.hostedSession.dispose();
    });
});

Deno.test("dispatch only mutates the supplied HostedSession", async () => {
    await withRuntimeCommandFixture("orchestrator-session-scope-", async ({ projectRoot, setModelMessages }) => {
        setModelMessages([fauxAssistantMessage(fauxText("Scoped guide answer."))]);
        const target = createSessionFixture(projectRoot);
        const other = createSessionFixture(projectRoot);
        const ci = defineLocalCIFixture();

        await dispatchPostTriage({
            hostedSession: target.hostedSession,
            triage: {
                routingIntent: "INQUIRY",
                complexity: "LOW",
                summary: "question",
            },
            userRequest: "Answer only here.",
            images: [],
            sessionManager: target.sessionManager,
            localCI: ci.port,
        });

        assertEquals(target.hostedSession.getRootAgentName(), "guide");
        assertEquals(other.hostedSession.getRootAgentName(), null);
        target.hostedSession.dispose();
        other.hostedSession.dispose();
    });
});
