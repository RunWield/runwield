import { assertEquals } from "../../testing/assertions.ts";
import { test } from "node:test";
import { type ExtensionToolContext, SessionManager } from "@earendil-works/pi-coding-agent";
import { loadPlan } from "../../plan-store.js";
import { createTaskCompletedTool } from "../../tools/task-completed.ts";
import { HostedSession } from "../session/hosted-session.js";
import { listPendingTaskCompletions } from "../session/task-completion-session.ts";
import { finalizePlanImplementation } from "./implementation-checkpoint.ts";
import { makeValidationProjectRoot } from "./validation-test-helpers.js";

const EXTENSION_CONTEXT = {} as ExtensionToolContext;
type HostedSessionManager = NonNullable<ConstructorParameters<typeof HostedSession>[0]["sessionManager"]>;

test("implementation checkpoint acknowledges its accepted task_completed JSONL event", async () => {
    const projectRoot = await makeValidationProjectRoot("p", {
        classification: "PLANNED_CHANGE",
        status: "in_progress",
        executionMode: "non_git_in_place",
    });
    const sessionManager = SessionManager.inMemory(projectRoot);
    const hostedSession = new HostedSession({
        id: "checkpoint-completion",
        cwd: projectRoot,
        sessionManager: sessionManager as HostedSessionManager,
    });
    const root = { dispose: () => {} };
    hostedSession.setRootAgentSession(root);
    const workflow: import("../types.js").ActiveExecutionWorkflow = {
        planName: "p",
        triageMeta: { classification: "PLANNED_CHANGE", status: "in_progress" },
        executionAgent: "engineer" as const,
        executionStarted: true,
        executionAttemptStartedAtMs: 1234,
        projectRoot,
        executionCwd: projectRoot,
        executionMode: "non_git_in_place" as const,
        nonGitInPlace: true,
    };
    hostedSession.setActiveExecutionWorkflow(workflow);
    const steeringTargetId = hostedSession.pushSteeringTargetSession(root);
    const tool = createTaskCompletedTool({
        hostedSession,
        agentName: "plan-engineer",
    });
    try {
        await tool.execute(
            "checkpoint-completion-call",
            { message: "- Implementation complete." },
            undefined,
            undefined,
            EXTENSION_CONTEXT,
        );
    } finally {
        hostedSession.popSteeringTargetSession(steeringTargetId);
    }
    assertEquals(listPendingTaskCompletions(hostedSession).length, 1);

    await finalizePlanImplementation({
        projectRoot,
        planName: "p",
        triageMeta: workflow.triageMeta,
        executionContext: workflow,
        executionReport: "- Implementation complete.",
        hostedSession,
    });

    assertEquals((await loadPlan(projectRoot, "p"))?.attrs.status, "implemented");
    assertEquals(listPendingTaskCompletions(hostedSession), []);
});
