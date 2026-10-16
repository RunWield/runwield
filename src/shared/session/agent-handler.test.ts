import { test } from "node:test";
import { assertEquals, assertRejects } from "../../testing/assertions.ts";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "@earendil-works/pi-ai";
import {
    defineTool,
    type ExtensionToolContext,
    SessionManager,
    type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { withRuntimeCommandFixture } from "../../cmd/testing/runtime-command-fixture.ts";
import { createTaskCompletedTool } from "../../tools/task-completed.ts";
import { type AgentHandler, createAgentHandler } from "./agent-handler.ts";
import { HostedSession } from "./hosted-session.js";
import { ensureRootAgentSession } from "./session.js";
import { RuntimeEventTypes } from "./session-runtime-events.js";
import { setCustomSetting } from "../settings.js";
import { listPendingWorkflowToolEvents, publishWorkflowToolEvent } from "../workflow/workflow-tool-events.ts";
import { listPendingTaskCompletions } from "./task-completion-session.ts";

const EXTENSION_CONTEXT = {} as ExtensionToolContext;
type HostedSessionManager = NonNullable<ConstructorParameters<typeof HostedSession>[0]["sessionManager"]>;

function hostedSessionManager(sessionManager: SessionManager): HostedSessionManager {
    return sessionManager as HostedSessionManager;
}

interface CapturedRuntimeEvent {
    type: string;
    agentName?: string;
    reason?: string;
    workflowMessage?: string;
    toolName?: string;
}

interface ActiveHandlerFixture {
    handler: AgentHandler;
    hostedSession: HostedSession;
    sessionManager: SessionManager;
}

async function activateHandler(
    projectRoot: string,
    agentName: string,
    events: CapturedRuntimeEvent[],
    customTools?: ToolDefinition[],
): Promise<ActiveHandlerFixture> {
    const sessionManager = SessionManager.inMemory(projectRoot);
    const hostedSession = new HostedSession({
        id: `agent-handler-${crypto.randomUUID()}`,
        cwd: projectRoot,
        sessionManager: hostedSessionManager(sessionManager),
        eventSink: { emit: (event: CapturedRuntimeEvent) => events.push(event) },
    });
    const handler = createAgentHandler(agentName, { hostedSession, customTools });
    await ensureRootAgentSession({
        hostedSession,
        agentName,
        activeHandler: handler,
        sessionManager,
        customTools,
    });
    return { handler, hostedSession, sessionManager };
}

function deferredVoid(): { promise: Promise<void>; resolve: () => void } {
    let resolve: () => void = () => {};
    const promise = new Promise<void>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

test("agent handler completes a real root turn and requests user attention", async () => {
    await withRuntimeCommandFixture("agent-handler-turn-", async ({ projectRoot, setModelResponse }) => {
        const events: CapturedRuntimeEvent[] = [];
        setModelResponse("Fixture answer from the real Guide root session.");
        const fixture = await activateHandler(projectRoot, "guide", events);

        const result = await fixture.handler("Explain the fixture.", [], fixture.sessionManager);

        assertEquals(result, { kind: "complete" });
        assertEquals(
            events.some(
                (event) =>
                    event.type === RuntimeEventTypes.ATTENTION_REQUESTED &&
                    event.reason === "agentStopped" &&
                    event.agentName === "guide",
            ),
            true,
        );
        fixture.hostedSession.dispose();
    });
});

test("agent handler settles the accepted plan tool before dispatch without another model answer", async () => {
    await withRuntimeCommandFixture("agent-handler-live-plan-", async ({ projectRoot, setModelMessages }) => {
        const events: CapturedRuntimeEvent[] = [];
        const toolPublished = deferredVoid();
        const releaseTool = deferredVoid();
        let toolReturned = false;
        const planTool = defineTool({
            name: "plan_written",
            label: "Plan Written",
            description: "Publish a saved Plan outcome for the live event handoff test.",
            parameters: Type.Object({}),
            async execute(toolCallId) {
                publishWorkflowToolEvent({
                    hostedSession: fixture.hostedSession,
                    toolCallId,
                    kind: "plan_written",
                    payload: { outcome: "saved", planName: "event-plan" },
                });
                toolPublished.resolve();
                await releaseTool.promise;
                toolReturned = true;
                return {
                    content: [{ type: "text" as const, text: "Plan saved." }],
                    details: { outcome: "saved", planName: "event-plan" },
                    terminate: false,
                };
            },
        });
        setModelMessages([fauxAssistantMessage(fauxToolCall("plan_written", {}))]);
        const fixture: ActiveHandlerFixture = await activateHandler(projectRoot, "guide", events, [planTool]);
        let handlerSettled = false;
        const handler = fixture.handler("Save the Plan.", [], fixture.sessionManager).finally(() => {
            handlerSettled = true;
        });

        await toolPublished.promise;
        await Promise.resolve();
        await Promise.resolve();
        assertEquals(handlerSettled, false);
        releaseTool.resolve();
        const result = await handler;

        assertEquals(result, { kind: "complete" });
        assertEquals(toolReturned, true);
        fixture.hostedSession.dispose();
    });
});

test("agent handler leaves a prior triage event for its original request", async () => {
    await withRuntimeCommandFixture("agent-handler-stale-triage-", async ({ projectRoot, setModelResponse }) => {
        const events: CapturedRuntimeEvent[] = [];
        setModelResponse("Answer the new request without routing the old one.");
        const fixture = await activateHandler(projectRoot, "router", events);
        publishWorkflowToolEvent({
            hostedSession: fixture.hostedSession,
            toolCallId: "prior-request-triage",
            kind: "triage_report",
            payload: {
                routingIntent: "OPERATION",
                complexity: "LOW",
                summary: "Old request",
                sessionName: "Old request",
            },
        });
        const result = await fixture.handler("A new request.", [], fixture.sessionManager);
        assertEquals(result, { kind: "complete" });
        assertEquals(fixture.hostedSession.getRootAgentName(), "router");
        fixture.hostedSession.dispose();
    });
});

test("agent handler safely stops a terminal Plan outcome after feedback", async () => {
    await withRuntimeCommandFixture(
        "agent-handler-feedback-terminal-",
        async ({ projectRoot, setModelResponseFactories }) => {
            const events: CapturedRuntimeEvent[] = [];
            const terminalPublished = deferredVoid();
            const releaseTerminalTool = deferredVoid();
            let toolCalls = 0;
            let providerCalls = 0;
            const planTool = defineTool({
                name: "plan_written",
                label: "Plan Written",
                description: "Publish Plan feedback followed by a terminal Plan outcome.",
                parameters: Type.Object({}),
                async execute(toolCallId) {
                    toolCalls += 1;
                    const outcome = toolCalls === 1 ? "feedback" : "saved";
                    publishWorkflowToolEvent({
                        hostedSession: fixture.hostedSession,
                        toolCallId,
                        kind: "plan_written",
                        payload: { outcome, planName: "event-plan" },
                    });
                    if (outcome === "saved") {
                        terminalPublished.resolve();
                        await releaseTerminalTool.promise;
                    }
                    return {
                        content: [{ type: "text" as const, text: `Plan ${outcome}.` }],
                        details: { outcome, planName: "event-plan" },
                        terminate: false,
                    };
                },
            });
            setModelResponseFactories([
                () => {
                    providerCalls += 1;
                    return fauxAssistantMessage(fauxToolCall("plan_written", {}));
                },
                () => {
                    providerCalls += 1;
                    return fauxAssistantMessage(fauxToolCall("plan_written", {}));
                },
                () => {
                    providerCalls += 1;
                    return fauxAssistantMessage(fauxToolCall("plan_written", {}));
                },
            ]);
            const fixture: ActiveHandlerFixture = await activateHandler(projectRoot, "guide", events, [planTool]);
            const handler = fixture.handler("Revise and save the Plan.", [], fixture.sessionManager);

            await terminalPublished.promise;
            releaseTerminalTool.resolve();
            const result = await handler;

            assertEquals(result, { kind: "complete" });
            assertEquals(toolCalls, 2);
            assertEquals(providerCalls, 2);
            fixture.hostedSession.dispose();
        },
    );
});

test("agent handler routes a real triage tool outcome through Operator completion", async () => {
    await withRuntimeCommandFixture("agent-handler-operation-", async ({ projectRoot, setModelMessages }) => {
        const events: CapturedRuntimeEvent[] = [];
        setModelMessages([
            fauxAssistantMessage(
                fauxToolCall("triage_report", {
                    routingIntent: "OPERATION",
                    complexity: "LOW",
                    summary: "Inspect the fixture state without changing code.",
                    sessionName: "Inspect fixture state",
                }),
            ),
            fauxAssistantMessage(
                fauxToolCall("task_completed", {
                    message: "- Inspected the isolated fixture state.",
                }),
            ),
        ]);
        const fixture = await activateHandler(projectRoot, "router", events);

        const result = await fixture.handler("Inspect the fixture state.", [], fixture.sessionManager);

        assertEquals(result, { kind: "complete" });
        assertEquals(fixture.hostedSession.getRootAgentName(), "operator");
        assertEquals(
            events.some((event) => event.type === RuntimeEventTypes.AGENT_CHANGED && event.agentName === "operator"),
            true,
        );
        assertEquals(
            events.some(
                (event) =>
                    event.type === RuntimeEventTypes.ASSISTANT_TEXT_DELTA && event.workflowMessage === "task_completed",
            ),
            true,
        );
        fixture.hostedSession.dispose();
    });
});

test("agent handler does not redispatch a stale Triage report on a later invocation", async () => {
    await withRuntimeCommandFixture("agent-handler-stale-triage-", async ({ projectRoot, setModelResponse }) => {
        const events: CapturedRuntimeEvent[] = [];
        setModelResponse("The later Router invocation completed without another routing decision.");
        const fixture = await activateHandler(projectRoot, "router", events);
        publishWorkflowToolEvent({
            hostedSession: fixture.hostedSession,
            toolCallId: "stale-triage",
            kind: "triage_report",
            payload: {
                routingIntent: "INQUIRY",
                complexity: "LOW",
                summary: "A prior Router invocation already reported this request.",
            },
        });

        const result = await fixture.handler("A later request.", [], fixture.sessionManager);

        assertEquals(result, { kind: "complete" });
        assertEquals(fixture.hostedSession.getRootAgentName(), "router");
        assertEquals(
            events.filter((event) => event.type === RuntimeEventTypes.AGENT_CHANGED && event.agentName === "guide"),
            [],
        );
        assertEquals(listPendingWorkflowToolEvents(fixture.hostedSession).length, 1);
        fixture.hostedSession.dispose();
    });
});

test("agent handler rejects a handler whose root Agent changed", async () => {
    await withRuntimeCommandFixture("agent-handler-drift-", async ({ projectRoot }) => {
        const events: CapturedRuntimeEvent[] = [];
        const fixture = await activateHandler(projectRoot, "guide", events);
        const staleRouterHandler = createAgentHandler("router", { hostedSession: fixture.hostedSession });

        await assertRejects(
            () => staleRouterHandler("Continue.", [], fixture.sessionManager),
            Error,
            'active handler "router" does not match root agent "guide"',
        );
        fixture.hostedSession.dispose();
    });
});

test("agent handler does not treat a resume phrase as Pair authority", async () => {
    await withRuntimeCommandFixture("agent-handler-pair-", async ({ projectRoot, setModelResponse }) => {
        const events: CapturedRuntimeEvent[] = [];
        setModelResponse("Continuing the isolated Pair execution.");
        const fixture = await activateHandler(projectRoot, "engineer", events);
        fixture.hostedSession.setActiveExecutionWorkflow({
            planName: "fixture-plan",
            triageMeta: { classification: "PLANNED_CHANGE" },
            executionAgent: "engineer",
            executionStarted: true,
            collaborationStyle: "pair",
            pairCheckpointCount: 1,
            pairPauseReason: "stop",
            pairStopRequested: true,
        });

        await fixture.handler("resume execution", [], fixture.sessionManager);

        assertEquals(fixture.hostedSession.getActiveExecutionWorkflow()?.pairPauseReason, "stop");
        assertEquals(fixture.hostedSession.getActiveExecutionWorkflow()?.pairStopRequested, true);
        fixture.hostedSession.dispose();
    });
});

test("agent handler replays accepted task_completed after HostedSession replacement", async () => {
    await withRuntimeCommandFixture("agent-handler-durable-completion-", async ({ projectRoot }) => {
        const sessionManager = SessionManager.inMemory(projectRoot);
        const original = new HostedSession({
            id: "durable-handler-original",
            cwd: projectRoot,
            sessionManager: hostedSessionManager(sessionManager),
        });
        original.setActiveExecutionWorkflow({
            planName: "durable-operation",
            triageMeta: {},
            executionAgent: "engineer",
            executionStarted: true,
            executionAttemptStartedAtMs: 1234,
        });
        // A Plan workflow, so the Agent that can complete it is the resolved
        // runtime owner rather than the `engineer` the workflow records.
        const tool = createTaskCompletedTool({
            hostedSession: original,
            agentName: "plan-engineer",
        });
        await tool.execute(
            "durable-handler-call",
            { message: "- Operation completed before restart." },
            undefined,
            undefined,
            EXTENSION_CONTEXT,
        );
        assertEquals(listPendingTaskCompletions(original).length, 1);

        const events: CapturedRuntimeEvent[] = [];
        const resumed = new HostedSession({
            id: "durable-handler-resumed",
            cwd: projectRoot,
            sessionManager: hostedSessionManager(sessionManager),
            eventSink: { emit: (event: CapturedRuntimeEvent) => events.push(event) },
        });
        const handler = createAgentHandler("plan-engineer", { hostedSession: resumed });
        await ensureRootAgentSession({
            hostedSession: resumed,
            agentName: "plan-engineer",
            activeHandler: handler,
            sessionManager,
        });

        const result = await handler("resume", [], sessionManager);

        assertEquals(result, { kind: "complete" });
        assertEquals(resumed.getActiveExecutionWorkflow(), null);
        assertEquals(listPendingTaskCompletions(resumed), []);
        assertEquals(
            events.some((event) => event.type === RuntimeEventTypes.ATTENTION_REQUESTED),
            true,
        );
        resumed.dispose();
    });
});

test("sequential QUICK_FIX completions each run Mechanical Validation", async () => {
    await withRuntimeCommandFixture("agent-handler-quick-fix-rearm-", async ({ projectRoot, setModelResponse }) => {
        setModelResponse("Continuing QUICK_FIX work.");
        await setCustomSetting(
            "verification_command",
            process.platform === "win32"
                ? `"${process.execPath}" ${"--eval"} "process.exit(0)"`
                : `'${process.execPath.replaceAll("'", "'\"'\"'")}' ${"--eval"} 'process.exit(0)'`,
            "project",
            projectRoot,
        );
        const events: CapturedRuntimeEvent[] = [];
        const fixture = await activateHandler(projectRoot, "engineer", events);
        fixture.hostedSession.setActiveExecutionWorkflow({
            planName: "quick-fix",
            triageMeta: { classification: "QUICK_FIX" },
            executionAgent: "engineer",
            executionStarted: true,
            executionAttemptStartedAtMs: 1,
            projectRoot,
            executionCwd: projectRoot,
            manualQaName: "sequential quick fix",
            manualQaContext: "Two separate completions in one QUICK_FIX session.",
        });
        const tool = createTaskCompletedTool({
            hostedSession: fixture.hostedSession,
            agentName: "engineer",
        });

        await tool.execute(
            "quick-fix-completion-1",
            { message: "- First task done." },
            undefined,
            undefined,
            EXTENSION_CONTEXT,
        );
        await fixture.handler("first completion", [], fixture.sessionManager);
        const firstWorkflow = fixture.hostedSession.getActiveExecutionWorkflow();
        assertEquals(firstWorkflow?.triageMeta?.classification, "QUICK_FIX");
        assertEquals(listPendingTaskCompletions(fixture.hostedSession), []);

        await tool.execute(
            "quick-fix-completion-2",
            { message: "- Second task done." },
            undefined,
            undefined,
            EXTENSION_CONTEXT,
        );
        await fixture.handler("second completion", [], fixture.sessionManager);

        const validationRuns = events.filter(
            (event) => event.type === RuntimeEventTypes.TOOL_START && event.toolName === "bash",
        );
        assertEquals(validationRuns.length, 2);
        assertEquals(fixture.hostedSession.getActiveExecutionWorkflow()?.triageMeta?.classification, "QUICK_FIX");
        assertEquals(listPendingTaskCompletions(fixture.hostedSession), []);
        fixture.hostedSession.dispose();
    });
});
