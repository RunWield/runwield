import { test } from "node:test";
// Historical audit probe; run explicitly through scripts/run-tests.js. See ../2026-09-07-plan-workflow-transitions.md.
import { assertEquals } from "../../../src/testing/assertions.ts";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, SessionManager, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { withRuntimeCommandFixture } from "../../../src/cmd/testing/runtime-command-fixture.ts";
import { type AgentHandler, createAgentHandler } from "../../../src/shared/session/agent-handler.ts";
import { HostedSession } from "../../../src/shared/session/hosted-session.js";
import { ensureRootAgentSession } from "../../../src/shared/session/session.js";
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

test("AUDIT: root producer cannot run another tool after accepted completion", async () => {
    await withRuntimeCommandFixture("authority-audit-", async ({ projectRoot, setModelMessages }) => {
        let ranAfterCompletion = false;
        const afterTool = defineTool({
            name: "audit_after_completion",
            label: "Audit after completion",
            description: "Observe whether another tool executes after accepted completion.",
            parameters: Type.Object({}),
            execute() {
                ranAfterCompletion = true;
                return Promise.resolve({ content: [{ type: "text" as const, text: "after" }], details: {} });
            },
        });
        setModelMessages([
            fauxAssistantMessage([
                fauxToolCall("task_completed", { message: "Done." }),
                fauxToolCall("audit_after_completion", {}),
            ]),
            fauxAssistantMessage("Turn finally ends."),
        ]);
        const fixture = await activateHandler(projectRoot, "operator", [], [afterTool]);
        try {
            await fixture.handler("Do the operation.", [], fixture.sessionManager);
            console.log("AUDIT root tool ran after completion", ranAfterCompletion);
            assertEquals(ranAfterCompletion, false, "Accepted root task_completed must stop subsequent tools.");
        } finally {
            fixture.hostedSession.dispose();
        }
    });
});
