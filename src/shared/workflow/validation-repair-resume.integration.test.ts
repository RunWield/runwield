import { assertEquals, assertExists, assertStringIncludes } from "@std/assert";
import { executeWorkflowTestTools } from "../../testing/workflow-agent-tools.ts";
import { join } from "@std/path";
import { SessionManager } from "@earendil-works/pi-coding-agent";

import { loadPlan, savePlan } from "../../plan-store.js";
import { HostedSession } from "../session/hosted-session.js";
import { TASK_COMPLETION_CUSTOM_TYPE } from "../session/task-completion-session.ts";
import { setExactProjectCustomSetting } from "../settings.js";
import { makeValidationCheckpoint } from "./validation-checkpoint.ts";
import type { SemanticReviewPort } from "./validation-session-adapter.ts";
import { continueWorkflowValidation } from "./validation-supervisor.ts";
import { runLocalCI } from "./validation-local-ci.ts";
import { attachRecorder, makeStubGitPort, makeUi, makeValidationProjectRoot } from "./validation-test-helpers.js";

type HostedSessionManager = NonNullable<ConstructorParameters<typeof HostedSession>[0]["sessionManager"]>;

type RepairPortOptions = {
    completed?: boolean;
    onRun?: () => Promise<void> | void;
};

function hostedSessionManager(sessionManager: SessionManager): HostedSessionManager {
    return sessionManager as HostedSessionManager;
}

function makeRepairPort(options: RepairPortOptions, counter: { runs: number }): SemanticReviewPort {
    return {
        runIsolatedAgentSession: async (request) => {
            counter.runs += 1;
            await options.onRun?.();
            if (options.completed !== false) {
                await executeWorkflowTestTools(request, [{
                    name: "task_completed",
                    arguments: { message: "- Repair completed." },
                }]);
            }
            return [];
        },
    };
}

async function makeImplementedPlan(attrs: Record<string, unknown> = {}) {
    const projectRoot = await makeValidationProjectRoot("p", {
        classification: "PLANNED_CHANGE",
        status: "implemented",
        humanReviewMode: "none",
        executionMode: "non_git_in_place",
        ...attrs,
    });
    return projectRoot;
}

function attachWorkflow(hostedSession: HostedSession, projectRoot: string, attrs: Record<string, unknown> = {}) {
    hostedSession.setActiveExecutionWorkflow({
        planName: "p",
        triageMeta: {
            classification: "PLANNED_CHANGE",
            status: "implemented",
            humanReviewMode: "none",
            ...attrs,
        },
        executionAgent: "engineer",
        projectRoot,
        executionCwd: projectRoot,
        executionMode: "non_git_in_place",
        nonGitInPlace: true,
        validationContinuation: true,
    });
}

async function runValidation(args: {
    hostedSession: HostedSession;
    projectRoot: string;
    triageMeta?: Record<string, unknown>;
    localCI: {
        run: (args: {
            hostedSession: HostedSession;
            cwd: string;
            settingsPolicy?: "ordinary-project" | "exact-project";
        }) => Promise<
            | { kind: "completed"; exitCode: number; output: string }
            | { kind: "canceled"; output: string }
            | {
                kind: "operational_failure";
                failure: import("./validation-operational-errors.ts").ValidationOperationalFailure;
                output: string;
            }
        >;
    };
    semanticReviewPort?: SemanticReviewPort;
}) {
    return await continueWorkflowValidation({
        trigger: "session_resume",
        hostedSession: args.hostedSession,
        planName: "p",
        planContent: "# p",
        triageMeta: {
            classification: "PLANNED_CHANGE",
            status: "implemented",
            humanReviewMode: "none",
            ...args.triageMeta,
        },
        git: makeStubGitPort(),
        localCI: args.localCI,
        semanticReviewPort: args.semanticReviewPort || {
            runIsolatedAgentSession: () => Promise.reject(new Error("unexpected isolated Agent turn")),
        },
        workRecordMnemotecaPort: {
            run: () => Promise.reject(new Error("publication must not run in this test")),
        },
    });
}

async function saveRunningMechanicalCheckpoint(projectRoot: string, attrs: Record<string, unknown> = {}) {
    const plan = await loadPlan(projectRoot, "p");
    assertExists(plan);
    await savePlan(projectRoot, "p", plan.body, {
        ...plan.attrs,
        ...attrs,
        validationCheckpoint: makeValidationCheckpoint({
            attemptId: "in-place",
            generation: crypto.randomUUID(),
            status: "implemented",
            phase: "mechanical",
            state: "running",
            ownerHostname: "not-this-host",
            ownerPid: 1,
        }),
    }, { expectedRevision: plan.revision });
}

Deno.test("human-review change repair resumes through CI and returns to Code Review", async () => {
    const projectRoot = await makeImplementedPlan({
        humanReviewMode: "always",
        humanReviewDecision: "changes_requested",
    });
    const sessionManager = SessionManager.inMemory(projectRoot);
    const ui = makeUi();
    const hostedSession = attachRecorder(
        new HostedSession({
            id: crypto.randomUUID(),
            cwd: projectRoot,
            sessionManager: hostedSessionManager(sessionManager),
        }),
        ui,
    );
    attachWorkflow(hostedSession, projectRoot, { humanReviewMode: "always", humanReviewDecision: "changes_requested" });

    let ciRuns = 0;
    const repairCounter = { runs: 0 };
    const result = await runValidation({
        hostedSession,
        projectRoot,
        triageMeta: { humanReviewMode: "always", humanReviewDecision: "changes_requested" },
        localCI: {
            run: () => {
                ciRuns += 1;
                return Promise.resolve(
                    ciRuns === 1
                        ? { kind: "completed", exitCode: 1, output: "type error" }
                        : { kind: "completed", exitCode: 0, output: "ok" },
                );
            },
        },
        semanticReviewPort: makeRepairPort({ completed: true }, repairCounter),
    });

    const plan = await loadPlan(projectRoot, "p");
    assertExists(plan);
    assertEquals(ciRuns, 2);
    assertEquals(repairCounter.runs, 1);
    assertEquals(plan.attrs.status, "reviewed");
    assertEquals(plan.attrs.humanReviewMode, "always");
    assertEquals(plan.attrs.humanReviewDecision, "changes_requested");
    assertEquals(result.kind, "paused");
    assertStringIncludes(ui.messages.join("\n"), "Need your review: http://127.0.0.1/review/code?token=test");
    assertEquals(
        sessionManager.getBranch().some((entry) =>
            entry.type === "custom" && entry.customType === TASK_COMPLETION_CUSTOM_TYPE
        ),
        false,
    );
});

Deno.test("mechanical failure state is durable before CI repair dispatch", async () => {
    const projectRoot = await makeImplementedPlan();
    const hostedSession = new HostedSession({ id: crypto.randomUUID(), cwd: projectRoot });
    attachWorkflow(hostedSession, projectRoot);
    const repairCounter = { runs: 0 };

    const result = await runValidation({
        hostedSession,
        projectRoot,
        localCI: { run: () => Promise.resolve({ kind: "completed", exitCode: 1, output: "type error" }) },
        semanticReviewPort: makeRepairPort({ completed: false }, repairCounter),
    });

    const plan = await loadPlan(projectRoot, "p");
    assertExists(plan);
    assertEquals(result.kind, "paused");
    assertEquals("awaitingTaskCompletion" in result && result.awaitingTaskCompletion, true);
    assertEquals(repairCounter.runs, 1);
    assertEquals(plan.attrs.status, "implemented");
    assertEquals(plan.attrs.validationCiAttempts, 1);
    assertEquals(plan.attrs.failureReason, "type error");
    assertEquals(plan.attrs.validationCheckpoint?.state, "paused");
    assertEquals(plan.attrs.validationCheckpoint?.nextPhase, "mechanical");
});

Deno.test("CI repair completion reloads the execution-tree settings command before validation advances", async () => {
    const projectRoot = await makeImplementedPlan();
    const settingsPath = join(projectRoot, ".wld", "settings.json");
    setExactProjectCustomSetting("verification_command", "printf first; exit 1", projectRoot);
    const ui = makeUi();
    const hostedSession = attachRecorder(new HostedSession({ id: crypto.randomUUID(), cwd: projectRoot }), ui);
    attachWorkflow(hostedSession, projectRoot);
    const beforeRepairStat = await Deno.stat(settingsPath);
    const repairCounter = { runs: 0 };

    const result = await runValidation({
        hostedSession,
        projectRoot,
        localCI: {
            run: (args) => runLocalCI(args),
        },
        semanticReviewPort: makeRepairPort({
            completed: true,
            onRun: async () => {
                setExactProjectCustomSetting("verification_command", "printf fixed; exit 0", projectRoot);
                await Deno.utime(
                    settingsPath,
                    beforeRepairStat.atime ?? new Date(0),
                    beforeRepairStat.mtime ?? new Date(0),
                );
            },
        }, repairCounter),
    });

    const plan = await loadPlan(projectRoot, "p");
    assertExists(plan);
    assertEquals(repairCounter.runs, 1, "repair must run exactly once after the failing command");
    assertEquals(ui.toolResults.length, 2, "validation must rerun CI after Task Completion");
    assertStringIncludes(ui.toolResults[0].result, "first");
    assertStringIncludes(ui.toolResults[1].result, "fixed");
    assertEquals(result.kind, "verified");
    assertEquals(plan.attrs.status, "verified");
});

Deno.test("process loss before CI repair dispatch reclaims the checkpoint and reruns Mechanical Validation", async () => {
    const projectRoot = await makeImplementedPlan();
    await saveRunningMechanicalCheckpoint(projectRoot);
    const hostedSession = new HostedSession({ id: crypto.randomUUID(), cwd: projectRoot });
    attachWorkflow(hostedSession, projectRoot);
    const repairCounter = { runs: 0 };
    let ciRuns = 0;

    const result = await runValidation({
        hostedSession,
        projectRoot,
        localCI: {
            run: () => {
                ciRuns += 1;
                return Promise.resolve({ kind: "completed", exitCode: 1, output: "still failing" });
            },
        },
        semanticReviewPort: makeRepairPort({ completed: false }, repairCounter),
    });

    assertEquals(result.kind, "paused");
    assertEquals(ciRuns, 1);
    assertEquals(repairCounter.runs, 1, "recovery may dispatch a new bounded repair only after fresh CI fails");
});

Deno.test("process loss during CI repair reruns checks and may dispatch a new repair without replaying the old turn", async () => {
    const projectRoot = await makeImplementedPlan({ validationCiAttempts: 1, failureReason: "old failure" });
    await saveRunningMechanicalCheckpoint(projectRoot, { validationCiAttempts: 1, failureReason: "old failure" });
    const hostedSession = new HostedSession({ id: crypto.randomUUID(), cwd: projectRoot });
    attachWorkflow(hostedSession, projectRoot, { validationCiAttempts: 1 });
    const repairCounter = { runs: 0 };
    let ciRuns = 0;

    const result = await runValidation({
        hostedSession,
        projectRoot,
        triageMeta: { validationCiAttempts: 1 },
        localCI: {
            run: () => {
                ciRuns += 1;
                return Promise.resolve({ kind: "completed", exitCode: 1, output: "still failing" });
            },
        },
        semanticReviewPort: makeRepairPort({ completed: false }, repairCounter),
    });

    assertEquals(result.kind, "paused");
    assertEquals(ciRuns, 1);
    assertEquals(repairCounter.runs, 1);
});

Deno.test("process loss after repair changes the worktree reruns checks and does not replay the repair turn", async () => {
    const projectRoot = await makeImplementedPlan({ humanReviewMode: "always" });
    const marker = `${projectRoot}/repair-marker.txt`;
    await Deno.writeTextFile(marker, "fixed\n");
    await saveRunningMechanicalCheckpoint(projectRoot, { validationCiAttempts: 1, failureReason: "old failure" });
    const hostedSession = attachRecorder(new HostedSession({ id: crypto.randomUUID(), cwd: projectRoot }), makeUi());
    attachWorkflow(hostedSession, projectRoot, { validationCiAttempts: 1, humanReviewMode: "always" });
    const repairCounter = { runs: 0 };
    let ciRuns = 0;

    const result = await runValidation({
        hostedSession,
        projectRoot,
        triageMeta: { validationCiAttempts: 1, humanReviewMode: "always" },
        localCI: {
            run: async () => {
                ciRuns += 1;
                const fixed = await Deno.readTextFile(marker).then(() => true).catch(() => false);
                return fixed
                    ? { kind: "completed", exitCode: 0, output: "ok" }
                    : { kind: "completed", exitCode: 1, output: "still failing" };
            },
        },
        semanticReviewPort: makeRepairPort({ completed: true }, repairCounter),
    });

    const plan = await loadPlan(projectRoot, "p");
    assertExists(plan);
    assertEquals(result.kind, "paused");
    assertEquals(ciRuns, 1);
    assertEquals(repairCounter.runs, 0);
    assertEquals(plan.attrs.status, "reviewed");
});

Deno.test("repair turn without task_completed settles paused and retry starts from Mechanical Validation", async () => {
    const projectRoot = await makeImplementedPlan();
    const hostedSession = new HostedSession({ id: crypto.randomUUID(), cwd: projectRoot });
    attachWorkflow(hostedSession, projectRoot);
    const firstRepairCounter = { runs: 0 };

    const first = await runValidation({
        hostedSession,
        projectRoot,
        localCI: { run: () => Promise.resolve({ kind: "completed", exitCode: 1, output: "first failure" }) },
        semanticReviewPort: makeRepairPort({ completed: false }, firstRepairCounter),
    });
    const paused = await loadPlan(projectRoot, "p");
    assertExists(paused);
    assertEquals(first.kind, "paused");
    assertEquals(paused.attrs.validationCheckpoint?.state, "paused");
    assertEquals(paused.attrs.validationCheckpoint?.nextPhase, "mechanical");

    const secondRepairCounter = { runs: 0 };
    const retrySession = new HostedSession({ id: crypto.randomUUID(), cwd: projectRoot });
    attachWorkflow(retrySession, projectRoot, { validationCiAttempts: paused.attrs.validationCiAttempts });
    let retryCiRuns = 0;
    const second = await runValidation({
        hostedSession: retrySession,
        projectRoot,
        triageMeta: { validationCiAttempts: paused.attrs.validationCiAttempts },
        localCI: {
            run: () => {
                retryCiRuns += 1;
                return Promise.resolve({ kind: "completed", exitCode: 1, output: "second failure" });
            },
        },
        semanticReviewPort: makeRepairPort({ completed: false }, secondRepairCounter),
    });

    assertEquals(second.kind, "paused");
    assertEquals(retryCiRuns, 1);
    assertEquals(secondRepairCounter.runs, 1);
});
