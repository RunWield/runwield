import { assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { withRuntimeCommandFixture } from "../../cmd/testing/runtime-command-fixture.ts";
import { loadPlan, savePlan } from "../../plan-store.js";
import { HostedSession } from "../session/hosted-session.js";
import { createValidationSessionPort } from "./validation-session-adapter.ts";
import { attachRecorder, makeUi, makeValidationProjectRoot, runValidationLoop } from "./validation-test-helpers.js";
import { executeWorkflowTestTools } from "../../testing/workflow-agent-tools.ts";
import { runWorkflowValidationToStableBoundary } from "./validation-supervisor.ts";
import { createGitPort } from "../git-port.ts";
import { createWorkRecordMnemotecaFixture } from "../work-records/test-fixtures/mnemoteca-port.ts";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { runValidationAgentUntilEvent } from "../session/agent-workflow-step.ts";
import { createTestWorktreeAttempt, git as runGit, makeRepo } from "../worktree-test-helpers.ts";
import { runActiveAgentTurn, switchActiveAgent } from "../session/agent-switching.js";
import { __getRootSessionMetadataForTests } from "../session/session.js";
import { runEpicChildContinuation } from "./epic-continuation.ts";

Deno.test("publication repair completion never creates a validation checkpoint in either checkout", async () => {
    const projectRoot = await makeRepo();
    const repairRoot = await Deno.makeTempDir({ prefix: "publication-repair-receipt-" });
    const hostedSession = new HostedSession({ id: crypto.randomUUID(), cwd: projectRoot });
    try {
        await savePlan(projectRoot, "p", "# Publication repair\n", {
            classification: "PLANNED_CHANGE",
            status: "validated",
            planId: "publication-repair-plan",
        });
        await runGit(projectRoot, ["add", "docs/plans/p.md"]);
        await runGit(projectRoot, ["commit", "-m", "Validated source"]);
        await runGit(projectRoot, ["clone", projectRoot, repairRoot]);
        hostedSession.setActiveExecutionWorkflow({
            planName: "p",
            projectRoot,
            executionCwd: projectRoot,
            executionMode: "worktree",
            executionAgent: "engineer",
            triageMeta: { classification: "PLANNED_CHANGE", status: "validated" },
            validationRepairGeneration: "stale-code-review-repair",
        });
        const port = createValidationSessionPort(hostedSession, {
            semanticReviewPort: {
                runIsolatedAgentSession: async (options) => {
                    await executeWorkflowTestTools(options, [{
                        name: "task_completed",
                        arguments: { message: "Conflicts staged." },
                    }]);
                    return [];
                },
            },
        });
        const outcome = await port.runIndependentRepairTurn({
            kind: "publication",
            agentName: "engineer",
            cwd: repairRoot,
            userRequest: "Resolve the publication conflict and stage the files.",
        });
        assertEquals(outcome, { completed: true, report: "Conflicts staged." });
        for (const cwd of [projectRoot, repairRoot]) {
            const plan = await loadPlan(cwd, "p");
            assertEquals(plan?.attrs.status, "reviewed");
            assertEquals(plan?.attrs.validationCheckpoint ?? null, null);
        }
    } finally {
        hostedSession.dispose();
        await Deno.remove(repairRoot, { recursive: true });
        await Deno.remove(projectRoot, { recursive: true });
    }
});

for (const outcome of ["canceled", "blocked"] as const) {
    Deno.test(`canceling human review (${outcome}) cannot publish through the outer driver`, async () => {
        const projectRoot = await makeValidationProjectRoot("p", {
            classification: "PLANNED_CHANGE",
            status: "reviewed",
            humanReviewMode: "ask",
            humanReviewDecision: null,
        });
        const hostedSession = new HostedSession({ id: crypto.randomUUID(), cwd: projectRoot });
        let prompts = 0;
        hostedSession.setInteractionAdapter({
            requestInteraction: () => {
                prompts += 1;
                return Promise.resolve({ outcome });
            },
        });
        const result = await runWorkflowValidationToStableBoundary({
            hostedSession,
            planName: "p",
            planContent: "# stale",
            triageMeta: { classification: "PLANNED_CHANGE", status: "reviewed" },
            git: createGitPort(),
            localCI: {
                run: () => {
                    throw new Error("Cancellation must not run CI");
                },
            },
            workRecordMnemotecaPort: createWorkRecordMnemotecaFixture(),
        });
        assertEquals(result.kind, "paused");
        assertEquals(result.continueValidation, undefined);
        assertEquals(prompts, 1);
        const plan = await loadPlan(projectRoot, "p");
        assertEquals(plan?.attrs.status, "reviewed");
        assertEquals(plan?.attrs.humanReviewDecision, null);
        hostedSession.dispose();
    });
}

Deno.test("verified Epic-child publication leaves the removed worktree before continuing the parent Epic", async () => {
    await withRuntimeCommandFixture("published-handoff-", async ({ setModelResponseFactories }) => {
        const projectRoot = await makeRepo();
        const worktreeRoot = await Deno.makeTempDir({ prefix: "runwield-validation-worktree-" });
        const parentPlan = "published-epic";
        const planName = `${parentPlan}/01-published-follow-up`;
        const nextPlanName = `${parentPlan}/02-frontend-follow-up`;
        try {
            await savePlan(projectRoot, parentPlan, `# ${parentPlan}\n\nEpic fixture\n`, {
                classification: "PROJECT",
                status: "ready_for_work",
                summary: "Epic fixture",
                affectedPaths: [],
                planId: "published-epic-plan",
            });
            await savePlan(projectRoot, planName, `# ${planName}\n\nvalidation fixture\n`, {
                classification: "PLANNED_CHANGE",
                status: "reviewed",
                summary: "validation fixture",
                affectedPaths: ["published-marker.txt"],
                planId: "published-follow-up-plan",
                parentPlan,
                order: 1,
                executionAgent: "engineer",
                executionMode: "worktree",
                humanReviewMode: "none",
            });
            await savePlan(projectRoot, nextPlanName, `# ${nextPlanName}\n\nfrontend fixture\n`, {
                classification: "PLANNED_CHANGE",
                status: "ready_for_work",
                summary: "frontend fixture",
                affectedPaths: [],
                planId: "frontend-follow-up-plan",
                parentPlan,
                order: 2,
                executionAgent: "frontend-engineer",
                executionMode: "non_git_in_place",
                humanReviewMode: "none",
            });
            await runGit(projectRoot, ["add", "."]);
            await runGit(projectRoot, ["commit", "-m", "add plan"]);
            const baseTree = await runGit(projectRoot, ["rev-parse", "HEAD^{tree}"]);
            const worktree = await createTestWorktreeAttempt({
                projectRoot,
                planName,
                planId: "published-follow-up-plan",
                worktreeRoot,
                attemptId: "attempt-1",
            });
            const worktreePlan = await loadPlan(worktree.path, planName);
            if (!worktreePlan) throw new Error("worktree Plan fixture disappeared");
            await savePlan(worktree.path, planName, `# ${planName}\n\nvalidation fixture\n`, {
                classification: "PLANNED_CHANGE",
                status: "reviewed",
                summary: "validation fixture",
                affectedPaths: ["published-marker.txt"],
                planId: "published-follow-up-plan",
                parentPlan,
                order: 1,
                executionAgent: "engineer",
                executionMode: "worktree",
                humanReviewMode: "none",
                executionBaselineTree: baseTree,
                worktreeId: worktree.id,
                worktreePath: worktree.path,
                worktreeBranch: worktree.branch,
                worktreeBaseBranch: "main",
            }, { expectedRevision: worktreePlan.revision });
            await Deno.writeTextFile(join(worktree.path, "published-marker.txt"), "from worktree\n");
            const hostedSession = new HostedSession({ id: crypto.randomUUID(), cwd: worktree.path });
            await switchActiveAgent(hostedSession, { agentName: "planner", cwd: worktree.path });
            hostedSession.setActiveExecutionWorkflow({
                planName,
                triageMeta: { classification: "PLANNED_CHANGE", status: "reviewed", parentPlan },
                executionAgent: "engineer",
                projectRoot,
                executionCwd: worktree.path,
                executionMode: "worktree",
                baselineTree: baseTree,
                worktreeId: worktree.id,
                worktreeBranch: worktree.branch,
                worktreeBaseBranch: "main",
            });

            const result = await runWorkflowValidationToStableBoundary({
                hostedSession,
                planName,
                planContent: `# ${planName}`,
                triageMeta: { classification: "PLANNED_CHANGE", status: "reviewed", parentPlan },
                git: createGitPort(),
                localCI: {
                    run: () => {
                        throw new Error("Publication regression should not run CI");
                    },
                },
                workRecordMnemotecaPort: createWorkRecordMnemotecaFixture(),
            });

            assertEquals(result.kind, "verified");
            assertEquals(await Deno.stat(worktree.path).then(() => true).catch(() => false), false);
            assertEquals(hostedSession.getActiveExecutionWorkflow(), null);
            assertEquals(hostedSession.getRootAgentName(), "engineer");
            const canonicalProjectRoot = await Deno.realPath(projectRoot);
            assertEquals(hostedSession.cwd, canonicalProjectRoot);
            const rootAgentSession = hostedSession.getRootAgentSession() as AgentSession | null;
            if (!rootAgentSession) throw new Error("Root Agent session was not rebuilt");
            assertEquals(__getRootSessionMetadataForTests(rootAgentSession)?.cwd, canonicalProjectRoot);
            const events: Array<{ type?: string; output?: string }> = [];
            hostedSession.setEventSink((event: { type?: string; output?: string }) => events.push(event));
            setModelResponseFactories([
                () =>
                    fauxAssistantMessage(fauxToolCall("bash", {
                        command: "pwd && git branch --show-current && cat published-marker.txt",
                    })),
                () => fauxAssistantMessage(fauxText("Tool checked.")),
            ]);
            await runActiveAgentTurn({
                hostedSession,
                agentName: "engineer",
                userRequest: "Check the rebuilt root tools.",
            });
            const shellOutput = events.find((event) =>
                event.type === "tool_end" && event.output?.includes("from worktree")
            )
                ?.output || "";
            assertStringIncludes(shellOutput, canonicalProjectRoot);
            assertStringIncludes(shellOutput, "main");
            assertStringIncludes(shellOutput, "from worktree");
            const continuation = result.epicContinuation;
            if (!continuation?.resolution) {
                throw new Error("Epic continuation resolution was not captured before cleanup");
            }
            assertEquals(continuation.completedPlanName, planName);
            assertEquals(continuation.projectRoot, canonicalProjectRoot);
            assertEquals(continuation.resolution.parentPlanName, parentPlan);
            assertEquals(continuation.resolution.childPlanName, nextPlanName);
            assertEquals(continuation.resolution.kind, "execute");
            setModelResponseFactories([() => fauxAssistantMessage(fauxText("Need more work."))]);
            const continuationResult = await runEpicChildContinuation({
                hostedSession,
                resolution: continuation.resolution,
            });
            assertEquals(continuationResult, null);
            assertEquals(hostedSession.getRootAgentName(), "frontend-engineer");
            const nextExecutionCwd = hostedSession.getActiveExecutionWorkflow()?.executionCwd;
            assertEquals(hostedSession.cwd, nextExecutionCwd);
            assertEquals(hostedSession.cwd === worktree.path, false);
            assertEquals(hostedSession.getActiveExecutionWorkflow()?.planName, nextPlanName);
            assertEquals(hostedSession.getActiveExecutionWorkflow()?.executionAgent, "frontend-engineer");
            const continuationRootSession = hostedSession.getRootAgentSession() as AgentSession | null;
            if (!continuationRootSession) throw new Error("Continuation root Agent session was not retained");
            assertEquals(__getRootSessionMetadataForTests(continuationRootSession)?.cwd, nextExecutionCwd);
            hostedSession.dispose();
        } finally {
            await Deno.remove(projectRoot, { recursive: true }).catch(() => {});
            await Deno.remove(worktreeRoot, { recursive: true }).catch(() => {});
        }
    });
});

Deno.test("paused validation keeps the execution Agent and worktree cwd", async () => {
    await withRuntimeCommandFixture("paused-context-", async () => {
        const projectRoot = await makeRepo();
        const worktreeRoot = await Deno.makeTempDir({ prefix: "runwield-paused-worktree-" });
        const planName = "paused-context";
        try {
            await savePlan(projectRoot, planName, `# ${planName}\n`, {
                classification: "PLANNED_CHANGE",
                status: "reviewed",
                summary: "paused fixture",
                affectedPaths: ["paused-marker.txt"],
                planId: "paused-context-plan",
                executionAgent: "engineer",
                executionMode: "worktree",
                humanReviewMode: "ask",
                humanReviewDecision: null,
            });
            await runGit(projectRoot, ["add", "."]);
            await runGit(projectRoot, ["commit", "-m", "add paused plan"]);
            const baseTree = await runGit(projectRoot, ["rev-parse", "HEAD^{tree}"]);
            const worktree = await createTestWorktreeAttempt({
                projectRoot,
                planName,
                planId: "paused-context-plan",
                worktreeRoot,
                attemptId: "paused-attempt",
            });
            const worktreePlan = await loadPlan(worktree.path, planName);
            if (!worktreePlan) throw new Error("worktree Plan fixture disappeared");
            await savePlan(worktree.path, planName, worktreePlan.markdown || `# ${planName}\n`, {
                ...worktreePlan.attrs,
                classification: "PLANNED_CHANGE",
                status: "reviewed",
                summary: "paused fixture",
                affectedPaths: ["paused-marker.txt"],
                planId: "paused-context-plan",
                executionAgent: "engineer",
                executionMode: "worktree",
                humanReviewMode: "ask",
                humanReviewDecision: null,
                executionBaselineTree: baseTree,
                worktreeId: worktree.id,
                worktreePath: worktree.path,
                worktreeBranch: worktree.branch,
                worktreeBaseBranch: "main",
            }, { expectedRevision: worktreePlan.revision });
            const hostedSession = new HostedSession({ id: crypto.randomUUID(), cwd: worktree.path });
            await switchActiveAgent(hostedSession, { agentName: "engineer", cwd: worktree.path });
            hostedSession.setInteractionAdapter({
                requestInteraction: () => Promise.resolve({ outcome: "canceled" }),
            });
            hostedSession.setActiveExecutionWorkflow({
                planName,
                triageMeta: { classification: "PLANNED_CHANGE", status: "reviewed" },
                executionAgent: "engineer",
                projectRoot,
                executionCwd: worktree.path,
                executionMode: "worktree",
                baselineTree: baseTree,
                worktreeId: worktree.id,
                worktreeBranch: worktree.branch,
                worktreeBaseBranch: "main",
            });
            const result = await runWorkflowValidationToStableBoundary({
                hostedSession,
                planName,
                planContent: `# ${planName}`,
                triageMeta: { classification: "PLANNED_CHANGE", status: "reviewed" },
                git: createGitPort(),
                localCI: {
                    run: () => {
                        throw new Error("Paused validation regression should not run CI");
                    },
                },
                workRecordMnemotecaPort: createWorkRecordMnemotecaFixture(),
            });
            assertEquals(result.kind, "paused");
            assertEquals(await Deno.stat(worktree.path).then(() => true).catch(() => false), true);
            assertEquals(hostedSession.getRootAgentName(), "engineer");
            assertEquals(hostedSession.getActiveExecutionWorkflow()?.executionCwd, worktree.path);
            const rootAgentSession = hostedSession.getRootAgentSession() as AgentSession | null;
            if (!rootAgentSession) throw new Error("Root Agent session was not retained");
            assertEquals(__getRootSessionMetadataForTests(rootAgentSession)?.cwd, worktree.path);
            hostedSession.dispose();
        } finally {
            await Deno.remove(projectRoot, { recursive: true }).catch(() => {});
            await Deno.remove(worktreeRoot, { recursive: true }).catch(() => {});
        }
    });
});

for (const repaired of [true, false]) {
    Deno.test(`third repair is checked before ${repaired ? "continuing" : "stopping without a fourth repair"}`, async () => {
        await withRuntimeCommandFixture("third-repair-boundary-", async ({ setModelResponseFactories }) => {
            const projectRoot = await makeValidationProjectRoot("p", {
                classification: "PLANNED_CHANGE",
                status: "implemented",
                humanReviewMode: "none",
            });
            const ui = makeUi();
            ui.promptSelect = () => Promise.resolve("stop");
            const hostedSession = attachRecorder(new HostedSession({ id: crypto.randomUUID(), cwd: projectRoot }), ui);
            hostedSession.setActiveExecutionWorkflow({
                planName: "p",
                triageMeta: { classification: "PLANNED_CHANGE", status: "implemented" },
                executionAgent: "engineer",
                projectRoot,
                executionCwd: projectRoot,
                executionMode: "non_git_in_place",
                nonGitInPlace: true,
            });
            let repairs = 0;
            let checks = 0;
            const repairResponse = () => {
                repairs += 1;
                Deno.writeTextFileSync(join(projectRoot, "implementation.txt"), String(repairs));
                return fauxAssistantMessage(fauxToolCall("task_completed", { message: `Repair ${repairs} finished.` }));
            };
            setModelResponseFactories([repairResponse, repairResponse, repairResponse]);
            const result = await runValidationLoop({
                hostedSession,
                planName: "p",
                planContent: "# p",
                triageMeta: { classification: "PLANNED_CHANGE", status: "implemented" },
                localCI: {
                    run: async () => {
                        checks += 1;
                        if (checks > 1) {
                            assertEquals(
                                await Deno.readTextFile(join(projectRoot, "implementation.txt")),
                                String(checks - 1),
                            );
                        }
                        return { kind: "completed", exitCode: repaired && checks === 4 ? 0 : 1, output: "test result" };
                    },
                },
            });
            assertEquals(repairs, 3);
            assertEquals(checks, 4);
            assertEquals(result.kind, repaired ? "verified" : "paused");
            assertEquals((await loadPlan(projectRoot, "p"))?.attrs.status, repaired ? "verified" : "implemented");
            hostedSession.dispose();
        });
    });
}

Deno.test("accepted completion stops the producer without waiting for natural turn end", async () => {
    const cwd = await makeValidationProjectRoot("p", { classification: "PLANNED_CHANGE", status: "implemented" });
    const hostedSession = new HostedSession({ id: crypto.randomUUID(), cwd });
    let interrupted = false;
    const port = createValidationSessionPort(hostedSession, {
        semanticReviewPort: {
            runIsolatedAgentSession: async (options) => {
                // This backend deliberately cannot finish naturally. Acceptance must
                // initiate its shutdown; a driver waiting for output would hang here.
                const stopped = new Promise<void>((resolve) => {
                    options.signal?.addEventListener("abort", () => {
                        interrupted = true;
                        resolve();
                    }, { once: true });
                });
                await executeWorkflowTestTools(options, [{
                    name: "task_completed",
                    arguments: { message: "Finished." },
                }]);
                await stopped;
                return [];
            },
        },
    });
    const result = await port.runIndependentRepairTurn({
        kind: "validation",
        agentName: "engineer",
        cwd,
        userRequest: "Fix it",
    });
    assertEquals(interrupted, true);
    assertEquals(result, { completed: true, report: "Finished." });
    hostedSession.dispose();
});

for (const foreign of [false, true]) {
    Deno.test(`${foreign ? "another Session's" : "an earlier invocation's"} completion cannot advance a repair`, async () => {
        const cwd = await makeValidationProjectRoot("p", { classification: "PLANNED_CHANGE", status: "implemented" });
        const hostedSession = new HostedSession({ id: crypto.randomUUID(), cwd });
        const sessionManager = SessionManager.inMemory(cwd);
        const options = { hostedSession, sessionManager, cwd, agentName: "engineer", userRequest: "Repair p" };
        const call = [{ name: "task_completed", arguments: { message: "Not this repair." } }];
        if (!foreign) await executeWorkflowTestTools(options, call);
        const result = await runValidationAgentUntilEvent(
            {
                runIsolatedAgentSession: async () => {
                    if (foreign) {
                        await executeWorkflowTestTools(
                            { ...options, sessionManager: SessionManager.inMemory(cwd) },
                            call,
                        );
                    }
                    return [];
                },
            },
            options,
            "task_completed",
        );
        assertEquals(result.event, null);
        assertEquals((await loadPlan(cwd, "p"))?.attrs.status, "implemented");
        hostedSession.dispose();
    });
}

Deno.test("canceling the CI follow-up prompt does not send the default feedback to an Engineer", async () => {
    const cwd = await makeValidationProjectRoot("p", {
        classification: "PLANNED_CHANGE",
        status: "implemented",
        validationCiAttempts: 3,
    });
    const hostedSession = new HostedSession({ id: crypto.randomUUID(), cwd });
    hostedSession.setInteractionAdapter({
        requestInteraction: (request) =>
            Promise.resolve(
                request.type === "select"
                    ? { outcome: "selected", value: "engineer_follow_up" }
                    : { outcome: "canceled" },
            ),
    });
    let repairs = 0;
    const result = await runWorkflowValidationToStableBoundary({
        hostedSession,
        planName: "p",
        planContent: "# p",
        triageMeta: { classification: "PLANNED_CHANGE", status: "implemented" },
        git: createGitPort(),
        localCI: { run: () => Promise.resolve({ kind: "completed", exitCode: 1, output: "Still fails" }) },
        semanticReviewPort: {
            runIsolatedAgentSession: () => {
                repairs += 1;
                return Promise.resolve([]);
            },
        },
        workRecordMnemotecaPort: createWorkRecordMnemotecaFixture(),
    });
    assertEquals(result.kind, "paused");
    assertEquals(repairs, 0);
    assertEquals((await loadPlan(cwd, "p"))?.attrs.validationCiAttempts, 3);
    hostedSession.dispose();
});

Deno.test("Engineer follow-up after restart rebuilds context and accepts a real completion tool", async () => {
    await withRuntimeCommandFixture("repair-restart-", async ({ setModelResponseFactory }) => {
        const cwd = await makeValidationProjectRoot("p", { classification: "PLANNED_CHANGE", status: "implemented" });
        const hostedSession = new HostedSession({ id: crypto.randomUUID(), cwd });
        hostedSession.setActiveExecutionWorkflow({
            planName: "p",
            triageMeta: { classification: "PLANNED_CHANGE", status: "implemented" },
            executionAgent: "engineer",
            executionCwd: cwd,
            executionMode: "non_git_in_place",
        });
        let prompt = "";
        setModelResponseFactory((context) => {
            prompt = JSON.stringify(context);
            return fauxAssistantMessage(fauxToolCall("task_completed", { message: "Restarted repair finished." }));
        });
        const result = await createValidationSessionPort(hostedSession).continueLastRepairTurn(
            "Fix the remaining validation failure",
        );
        assertEquals(result?.completed, true);
        assertStringIncludes(prompt, "Fix the remaining validation failure");
        assertStringIncludes(prompt, "Continue the interrupted validation repair");
        hostedSession.dispose();
    });
});
