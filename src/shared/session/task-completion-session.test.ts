import { mkdir as fsMkdir, mkdtemp as fsMkdtemp, readFile as fsReadFile, rm as fsRm } from "node:fs/promises";
import { test } from "node:test";
import { tmpdir } from "node:os";
import { assertEquals, assertExists } from "../../testing/assertions.ts";
import { join } from "node:path";
import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createTaskCompletedTool } from "../../tools/task-completed.ts";
import { makeToolProjectFixture } from "../../testing/workflow-metrics-fixture.ts";
import { HostedSession } from "./hosted-session.js";
import { exportRootSessionToJsonl } from "./root-session.js";
import {
    acknowledgeTaskCompletion,
    claimPendingTaskCompletion,
    listPendingTaskCompletions,
    TASK_COMPLETION_CUSTOM_TYPE,
} from "./task-completion-session.ts";

const EXTENSION_CONTEXT = {} as ExtensionToolContext;
const TASK_COMPLETION_PROJECT_ROOT = makeToolProjectFixture("runwield-task-completion-session-");
type HostedSessionManager = NonNullable<ConstructorParameters<typeof HostedSession>[0]["sessionManager"]>;

function hostedSessionManager(sessionManager: SessionManager): HostedSessionManager {
    return sessionManager as HostedSessionManager;
}

function executionWorkflow(planName: string): import("../types.js").ActiveExecutionWorkflow {
    return {
        planName,
        triageMeta: { classification: "PLANNED_CHANGE" },
        executionAgent: "engineer" as const,
        executionStarted: true,
        executionMode: "non_git_in_place" as const,
        nonGitInPlace: true,
        executionAttemptStartedAtMs: 1234,
    };
}

test("task completion claim survives process resume until validation handles it", async () => {
    const sessionManager = SessionManager.inMemory(TASK_COMPLETION_PROJECT_ROOT);
    const original = new HostedSession({
        id: "durable-completion-original",
        cwd: TASK_COMPLETION_PROJECT_ROOT,
        sessionManager: hostedSessionManager(sessionManager),
    });
    original.setActiveExecutionWorkflow(executionWorkflow("durable-plan"));
    const tool = createTaskCompletedTool({
        hostedSession: original,
        agentName: "plan-engineer",
        now: () => 1234,
    });

    await tool.execute(
        "completion-call",
        { message: "- Completed before restart." },
        undefined,
        undefined,
        EXTENSION_CONTEXT,
    );

    assertEquals(listPendingTaskCompletions(original).length, 1);

    // A new HostedSession has no volatile pending record. It recovers solely from
    // the root SessionManager's append-only JSONL entries.
    const resumed = new HostedSession({
        id: "durable-completion-resumed",
        cwd: TASK_COMPLETION_PROJECT_ROOT,
        sessionManager: hostedSessionManager(sessionManager),
    });
    const resumedRoot = { dispose: () => {} };
    resumed.setRootAgentSession(resumedRoot);
    const completion = claimPendingTaskCompletion(resumed, resumedRoot);

    assertExists(completion);
    assertEquals(completion.report, "- Completed before restart.");
    assertEquals(completion.workflow?.planName, "durable-plan");
    assertEquals(completion.durable, true);

    acknowledgeTaskCompletion(resumed, completion, 2345);

    assertEquals(listPendingTaskCompletions(resumed), []);
    assertEquals(claimPendingTaskCompletion(resumed, resumedRoot), null);
    const journalEntries = sessionManager.getBranch().filter((entry) =>
        entry.type === "custom" && entry.customType === TASK_COMPLETION_CUSTOM_TYPE
    );
    assertEquals(journalEntries.length, 2);
});

test("accepted task completion is recovered from a reopened session JSONL", async () => {
    const fixtureRoot = await fsMkdtemp(join(tmpdir(), "runwield-task-completion-jsonl-"));
    const projectRoot = join(fixtureRoot, "project");
    const sessionDir = join(fixtureRoot, "sessions");
    await fsMkdir(projectRoot, { recursive: true });
    try {
        const sessionManager = SessionManager.create(projectRoot, sessionDir, { id: "durable-jsonl" });
        sessionManager.appendMessage({
            role: "user",
            timestamp: Date.now(),
            content: [{ type: "text", text: "Start the durable completion fixture." }],
        });
        const original = new HostedSession({
            id: "durable-jsonl-original",
            cwd: projectRoot,
            sessionManager: hostedSessionManager(sessionManager),
        });
        original.setActiveExecutionWorkflow(executionWorkflow("jsonl-plan"));
        const tool = createTaskCompletedTool({
            hostedSession: original,
            agentName: "plan-engineer",
        });
        await tool.execute(
            "jsonl-completion",
            { message: "- Persisted to JSONL." },
            undefined,
            undefined,
            EXTENSION_CONTEXT,
        );
        const sessionPath = exportRootSessionToJsonl(sessionManager, sessionManager.getSessionFile());
        assertExists(sessionPath);
        assertEquals((await fsReadFile(sessionPath, "utf8")).includes(TASK_COMPLETION_CUSTOM_TYPE), true);

        const reopenedManager = SessionManager.open(sessionPath, sessionDir, projectRoot);
        const resumed = new HostedSession({
            id: "durable-jsonl-resumed",
            cwd: projectRoot,
            sessionManager: hostedSessionManager(reopenedManager),
        });
        const root = { dispose: () => {} };
        resumed.setRootAgentSession(root);
        const completion = claimPendingTaskCompletion(resumed, root);

        assertExists(completion);
        assertEquals(completion.report, "- Persisted to JSONL.");
        acknowledgeTaskCompletion(resumed, completion);
        assertEquals(listPendingTaskCompletions(resumed), []);
        exportRootSessionToJsonl(reopenedManager, sessionPath);

        const reopenedAfterAcknowledgment = SessionManager.open(sessionPath, sessionDir, projectRoot);
        const afterAcknowledgment = new HostedSession({
            id: "durable-jsonl-after-acknowledgment",
            cwd: projectRoot,
            sessionManager: hostedSessionManager(reopenedAfterAcknowledgment),
        });
        assertEquals(listPendingTaskCompletions(afterAcknowledgment), []);
    } finally {
        await fsRm(fixtureRoot, { recursive: true });
    }
});

test("isolated task completion remains outside the root JSONL outbox", async () => {
    const sessionManager = SessionManager.inMemory(TASK_COMPLETION_PROJECT_ROOT);
    const hostedSession = new HostedSession({
        id: "isolated-completion",
        cwd: TASK_COMPLETION_PROJECT_ROOT,
        sessionManager: hostedSessionManager(sessionManager),
    });
    const root = { dispose: () => {} };
    const isolated = { dispose: () => {} };
    hostedSession.setRootAgentSession(root);
    hostedSession.setActiveExecutionWorkflow(executionWorkflow("isolated-plan"));
    const steeringTargetId = hostedSession.pushSteeringTargetSession(isolated);
    const tool = createTaskCompletedTool({
        hostedSession,
        agentName: "plan-engineer",
    });
    try {
        await tool.execute(
            "isolated-call",
            { message: "- Isolated work completed." },
            undefined,
            undefined,
            EXTENSION_CONTEXT,
        );
    } finally {
        hostedSession.popSteeringTargetSession(steeringTargetId);
    }

    assertEquals(listPendingTaskCompletions(hostedSession), []);
    assertEquals(claimPendingTaskCompletion(hostedSession, root), null);
    assertEquals(claimPendingTaskCompletion(hostedSession, isolated)?.report, "- Isolated work completed.");
    assertEquals(
        sessionManager.getBranch().some((entry) =>
            entry.type === "custom" && entry.customType === TASK_COMPLETION_CUSTOM_TYPE
        ),
        false,
    );
});

test("durable completion does not cross into a different active workflow", async () => {
    const sessionManager = SessionManager.inMemory(TASK_COMPLETION_PROJECT_ROOT);
    const original = new HostedSession({
        id: "completion-scope-original",
        cwd: TASK_COMPLETION_PROJECT_ROOT,
        sessionManager: hostedSessionManager(sessionManager),
    });
    original.setActiveExecutionWorkflow(executionWorkflow("first-plan"));
    const tool = createTaskCompletedTool({
        hostedSession: original,
        agentName: "plan-engineer",
    });
    await tool.execute(
        "first-plan-completion",
        { message: "- First plan completed." },
        undefined,
        undefined,
        EXTENSION_CONTEXT,
    );

    const resumed = new HostedSession({
        id: "completion-scope-resumed",
        cwd: TASK_COMPLETION_PROJECT_ROOT,
        sessionManager: hostedSessionManager(sessionManager),
    });
    const root = { dispose: () => {} };
    resumed.setRootAgentSession(root);
    resumed.setActiveExecutionWorkflow(executionWorkflow("second-plan"));

    assertEquals(claimPendingTaskCompletion(resumed, root), null);
    assertEquals(listPendingTaskCompletions(resumed).length, 1);
});

test("acknowledging one completion consumes only that completion", async () => {
    const sessionManager = SessionManager.inMemory(TASK_COMPLETION_PROJECT_ROOT);
    const original = new HostedSession({
        id: "duplicate-completion-original",
        cwd: TASK_COMPLETION_PROJECT_ROOT,
        sessionManager: hostedSessionManager(sessionManager),
    });
    original.setActiveExecutionWorkflow(executionWorkflow("duplicate-plan"));
    const tool = createTaskCompletedTool({
        hostedSession: original,
        agentName: "plan-engineer",
    });
    await tool.execute(
        "duplicate-first",
        { message: "- First completion." },
        undefined,
        undefined,
        EXTENSION_CONTEXT,
    );
    await tool.execute(
        "duplicate-second",
        { message: "- Second completion." },
        undefined,
        undefined,
        EXTENSION_CONTEXT,
    );
    assertEquals(listPendingTaskCompletions(original).length, 2);

    const resumed = new HostedSession({
        id: "duplicate-completion-resumed",
        cwd: TASK_COMPLETION_PROJECT_ROOT,
        sessionManager: hostedSessionManager(sessionManager),
    });
    const root = { dispose: () => {} };
    resumed.setRootAgentSession(root);
    resumed.setActiveExecutionWorkflow(executionWorkflow("duplicate-plan"));
    const completion = claimPendingTaskCompletion(resumed, root);
    assertExists(completion);
    assertEquals(completion.report, "- Second completion.");

    acknowledgeTaskCompletion(resumed, completion);

    const pending = listPendingTaskCompletions(resumed);
    assertEquals(pending.length, 1);
    assertEquals(pending[0].report, "- First completion.");
});
