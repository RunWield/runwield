import { assertEquals, assertExists, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import {
    injectFrontMatter,
    loadPlan,
    parsePlanFrontMatter,
    savePlan,
    updatePlanFrontMatter,
} from "../../plan-store.js";
import { createGitPort } from "../git-port.ts";
import { defineGitFixture, git } from "../git-test-fixture.ts";
import { HostedSession } from "../session/hosted-session.js";
import { addEntry, findById } from "../worktree-registry.js";
import { resolveValidationExecutionContext } from "./execution-context.ts";
import { continueWorkflowValidation } from "./validation-supervisor.ts";
import { attachRecorder, makeUi, makeValidationProjectRoot } from "./validation-test-helpers.js";
import { getCurrentValidationProgress } from "./validation-progress.ts";

Deno.test("an interrupted validation clears running progress while retaining a resumable Plan", async () => {
    const projectRoot = await makeValidationProjectRoot("p", {
        classification: "PLANNED_CHANGE",
        status: "implemented",
    });
    const hostedSession = attachRecorder(new HostedSession({ id: crypto.randomUUID(), cwd: projectRoot }), makeUi());
    try {
        const result = await continueWorkflowValidation({
            hostedSession,
            planName: "p",
            planContent: "# p",
            triageMeta: { classification: "PLANNED_CHANGE", status: "implemented" },
            git: createGitPort(),
            localCI: { run: () => Promise.reject(new Error("CI process disconnected")) },
            workRecordMnemotecaPort: { run: () => Promise.reject(new Error("publication must not run")) },
        });
        assertEquals(result.kind, "paused");
        const progress = getCurrentValidationProgress(hostedSession);
        assertExists(progress);
        assertEquals(progress.outcome, "paused");
        assertEquals(Object.values(progress.checks).includes("running"), false);
        assertEquals((await loadPlan(projectRoot, "p"))?.attrs.status, "implemented");
    } finally {
        hostedSession.dispose();
        await Deno.remove(projectRoot, { recursive: true });
    }
});

const fixture = defineGitFixture(async (repoPath) => {
    await Deno.writeTextFile(join(repoPath, "README.md"), "# Validation fixture\n");
    await git(repoPath, ["add", "."]);
    await git(repoPath, ["commit", "-m", "fixture base"]);
});

async function makeReportedMismatchFixture() {
    const projectRoot = await fixture.checkout({ prefix: "runwield-validation-self-heal-" });
    await savePlan(projectRoot, "demo", "# Demo\n\nKeep the approved body.\n", {
        planId: "plan-demo",
        classification: "PLANNED_CHANGE",
        workKind: "REFACTOR",
        status: "ready_for_work",
        targetBranch: "main",
        summary: "Check stale Plan data",
        affectedPaths: ["README.md"],
        executionAgent: "engineer",
        collaborationRecommendation: "autonomous",
        executionMode: "worktree",
    });
    await git(projectRoot, ["add", "docs/plans/demo.md"]);
    await git(projectRoot, ["commit", "-m", "approve demo plan"]);

    const baseCommit = await git(projectRoot, ["rev-parse", "HEAD"]);
    const baselineTree = await git(projectRoot, ["rev-parse", "HEAD^{tree}"]);
    const worktreeParent = await Deno.makeTempDir({ prefix: "runwield-validation-self-heal-worktrees-" });
    const executionCwd = join(worktreeParent, "demo");
    const branch = "runwield/worktree/demo-wt-demo";
    await git(projectRoot, ["worktree", "add", "-b", branch, executionCwd, "HEAD"]);
    await Deno.writeTextFile(join(executionCwd, "README.md"), "# Validation fixture\n\nImplemented change.\n");

    // Reproduce stale RunWield-owned identity while keeping the execution Plan's
    // user-owned definition and lifecycle authoritative.
    const executionPath = join(executionCwd, "docs", "plans", "demo.md");
    const staleExecution = injectFrontMatter("# Demo\n\nKeep the approved body.\n", {
        planId: "plan-stale-copy",
        classification: "PLANNED_CHANGE",
        workKind: "REFACTOR",
        status: "implemented",
        targetBranch: "main",
        summary: "Check stale Plan data",
        affectedPaths: ["README.md"],
        executionAgent: "engineer",
        collaborationRecommendation: "autonomous",
        executionMode: "worktree",
    });
    await Deno.writeTextFile(executionPath, staleExecution);
    const staleAttrs = parsePlanFrontMatter(await Deno.readTextFile(executionPath)).attrs;
    assertEquals(staleAttrs.planId, "plan-stale-copy");
    assertEquals(staleAttrs.collaborationRecommendation, "autonomous");

    const primary = await loadPlan(projectRoot, "demo");
    assertExists(primary);
    await savePlan(projectRoot, "demo", primary.body, {
        ...primary.attrs,
        status: "implemented",
        implementedAt: "2026-08-13T00:00:00.000Z",
        executionMode: "worktree",
        executionBaselineTree: baselineTree,
        worktreeId: "wt-demo",
        worktreePath: executionCwd,
        worktreeBranch: branch,
        worktreeBaseBranch: "main",
        worktreeStatus: "completed",
    }, { expectedRevision: primary.revision });
    await addEntry(projectRoot, {
        id: "wt-demo",
        planName: "demo",
        planId: "plan-demo",
        baseBranch: "main",
        baseRef: "refs/heads/main",
        baseCommit,
        baseTree: baselineTree,
        executionBaselineTree: baselineTree,
        branch,
        path: executionCwd,
        status: "completed",
        createdAt: "2026-08-13T00:00:00.000Z",
        updatedAt: "2026-08-13T00:00:00.000Z",
    });

    return { projectRoot, executionCwd, executionPath, worktreeParent, branch, baseCommit, baselineTree };
}

async function removeFixture(fixturePaths: { projectRoot: string; worktreeParent: string }) {
    await git(fixturePaths.projectRoot, ["worktree", "remove", "--force", join(fixturePaths.worktreeParent, "demo")])
        .catch(() => {});
    await Deno.remove(fixturePaths.worktreeParent, { recursive: true }).catch(() => {});
    await Deno.remove(fixturePaths.projectRoot, { recursive: true }).catch(() => {});
}

Deno.test("stale RunWield state self-heals and validation continues", async () => {
    const testFixture = await makeReportedMismatchFixture();
    try {
        let ciRuns = 0;
        const recorder = makeUi();
        const hostedSession = attachRecorder(
            new HostedSession({ id: "validation-self-healing", cwd: testFixture.projectRoot }),
            recorder,
        );
        hostedSession.setActiveExecutionWorkflow({
            planName: "demo",
            triageMeta: {
                planId: "stale-session-id",
                classification: "PLANNED_CHANGE",
                collaborationRecommendation: "pair",
            },
            executionAgent: "engineer",
            executionStarted: true,
            executionMode: "worktree",
            executionCwd: join(testFixture.worktreeParent, "wrong-path"),
            worktreeId: "stale-worktree-id",
            worktreeBranch: "stale-branch",
            worktreeBaseBranch: "stale-target",
            baselineTree: "stale-tree",
        });

        const result = await continueWorkflowValidation({
            trigger: "load_plan",
            hostedSession,
            planName: "demo",
            planContent: "stale caller body",
            triageMeta: {
                planId: "stale-caller-id",
                classification: "PLANNED_CHANGE",
                status: "implemented",
                collaborationRecommendation: "pair",
            },
            executionContext: {
                planName: "demo",
                triageMeta: { classification: "PLANNED_CHANGE", planId: "stale-context-id" },
                executionAgent: "engineer",
                executionStarted: true,
                executionMode: "worktree",
                executionCwd: join(testFixture.worktreeParent, "another-wrong-path"),
                worktreeId: "another-stale-worktree-id",
                worktreeBranch: "another-stale-branch",
                worktreeBaseBranch: "another-stale-target",
                baselineTree: "another-stale-tree",
            },
            git: createGitPort(),
            localCI: {
                run: async ({ cwd }) => {
                    ciRuns += 1;
                    assertEquals(cwd, await Deno.realPath(testFixture.executionCwd));
                    return { kind: "completed", exitCode: 0, output: "ok" };
                },
            },
            semanticReviewPort: {
                runIsolatedAgentSession: () => Promise.reject(new Error("stop after mechanical proof")),
            },
            workRecordMnemotecaPort: {
                run: () => Promise.reject(new Error("publication must not run in this test")),
            },
        });

        assertEquals(result.kind, "failed", result.reason || "the fake semantic boundary must stop validation");
        assertEquals(ciRuns, 1, `fresh Mechanical Validation must run once: ${JSON.stringify(result)}`);
        const executionAfter = parsePlanFrontMatter(await Deno.readTextFile(testFixture.executionPath));
        assertEquals(executionAfter.attrs.planId, "plan-demo");
        assertEquals(executionAfter.attrs.collaborationRecommendation, "autonomous");
        assertEquals(executionAfter.attrs.status, "implemented");
        assertEquals(executionAfter.body, "# Demo\n\nKeep the approved body.\n");
        const primaryAfter = await loadPlan(testFixture.projectRoot, "demo");
        assertExists(primaryAfter);
        assertEquals(primaryAfter.attrs.status, "implemented");
        const savedWorktree = await findById(testFixture.projectRoot, "wt-demo");
        assertExists(savedWorktree);
        assertEquals(await Deno.realPath(savedWorktree.path), await Deno.realPath(testFixture.executionCwd));

        const shown = recorder.messages.join("\n");
        assertEquals(shown.includes("fresh Plan review"), false);
        assertEquals(shown.includes("execution-shaping"), false);
        assertEquals(shown.includes("planId"), false);
        assertEquals(shown.includes("collaborationRecommendation"), false);
        assertStringIncludes(shown, "Running the tests in");
    } finally {
        await removeFixture(testFixture);
    }
});

Deno.test("body-only Plan amendment no longer prompts before Mechanical Validation", async () => {
    const testFixture = await makeReportedMismatchFixture();
    try {
        const primary = await loadPlan(testFixture.projectRoot, "demo");
        const execution = await loadPlan(testFixture.executionCwd, "demo");
        assertExists(primary);
        assertExists(execution);
        await savePlan(
            testFixture.executionCwd,
            "demo",
            "# Demo\n\nEngineer clarified the implementation notes.\n",
            primary.attrs,
            { expectedRevision: execution.revision },
        );

        const recorder = makeUi();
        const prompts: string[] = [];
        recorder.promptSelect = (prompt: string) => {
            prompts.push(prompt);
            return Promise.resolve("stop");
        };
        const hostedSession = attachRecorder(
            new HostedSession({ id: "validation-body-amendment", cwd: testFixture.projectRoot }),
            recorder,
        );
        hostedSession.setActiveExecutionWorkflow({
            planName: "demo",
            triageMeta: primary.attrs,
            executionAgent: "engineer",
            executionStarted: true,
            executionMode: "worktree",
            executionCwd: testFixture.executionCwd,
            worktreeId: "wt-demo",
            worktreeBranch: testFixture.branch,
            worktreeBaseBranch: "main",
            baselineTree: testFixture.baselineTree,
        });
        let ciRuns = 0;
        const result = await continueWorkflowValidation({
            trigger: "task_completion",
            hostedSession,
            planName: "demo",
            planContent: primary.markdown,
            triageMeta: primary.attrs,
            git: createGitPort(),
            localCI: {
                run: () => {
                    ciRuns += 1;
                    return Promise.resolve({ kind: "completed", exitCode: 0, output: "ok" });
                },
            },
            semanticReviewPort: {
                runIsolatedAgentSession: () => Promise.reject(new Error("stop after Mechanical Validation proof")),
            },
            workRecordMnemotecaPort: {
                run: () => Promise.reject(new Error("publication must not run")),
            },
        });

        assertEquals(prompts.length, 0);
        assertEquals(ciRuns, 1);
        assertEquals(result.kind, "failed");
        const executionAfter = await loadPlan(testFixture.executionCwd, "demo");
        assertExists(executionAfter);
        assertEquals(executionAfter.body, "# Demo\n\nEngineer clarified the implementation notes.\n");
        assertEquals(executionAfter.attrs.status, "implemented");
        const primaryAfter = await loadPlan(testFixture.projectRoot, "demo");
        assertExists(primaryAfter);
        assertEquals(primaryAfter.body, "# Demo\n\nKeep the approved body.\n");
        assertEquals(primaryAfter.attrs.status, "implemented");
        assertEquals(recorder.messages.join("\n").includes("The Plan change is saved"), false);
    } finally {
        await removeFixture(testFixture);
    }
});

Deno.test("durable registry recovery returns the worktree base commit", async () => {
    const testFixture = await makeReportedMismatchFixture();
    try {
        const resolution = await resolveValidationExecutionContext({
            projectRoot: testFixture.projectRoot,
            planName: "demo",
            triageMeta: { classification: "PLANNED_CHANGE", status: "implemented" },
        });
        assertEquals(resolution.kind, "ok");
        if (resolution.kind === "ok" && resolution.context.executionMode === "worktree") {
            assertEquals(resolution.context.worktreeBaseCommit, testFixture.baseCommit);
        }
    } finally {
        await removeFixture(testFixture);
    }
});

Deno.test("a missing worktree is restored from its branch", async () => {
    const testFixture = await makeReportedMismatchFixture();
    try {
        await git(testFixture.executionCwd, ["add", "."]);
        await git(testFixture.executionCwd, ["commit", "-m", "save implementation"]);
        await Deno.remove(testFixture.executionCwd, { recursive: true });
        await git(testFixture.projectRoot, ["worktree", "prune"]);

        const plan = await loadPlan(testFixture.projectRoot, "demo");
        assertExists(plan);
        const resolution = await resolveValidationExecutionContext({
            projectRoot: testFixture.projectRoot,
            planName: "demo",
            triageMeta: plan.attrs,
        });

        assertEquals(resolution.kind, "ok");
        if (resolution.kind === "ok") {
            assertEquals(resolution.context.executionMode, "worktree");
            assertEquals(
                await Deno.realPath(resolution.context.executionCwd),
                await Deno.realPath(testFixture.executionCwd),
            );
            assertEquals(
                resolution.selfHealNotices?.some((notice) => notice.kind === "worktree_restored"),
                true,
            );
        }
        assertEquals(await git(testFixture.executionCwd, ["branch", "--show-current"]), testFixture.branch);
        assertStringIncludes(
            await Deno.readTextFile(join(testFixture.executionCwd, "README.md")),
            "Implemented change",
        );
    } finally {
        await removeFixture(testFixture);
    }
});

Deno.test("a durable validation field survives a fresh project read", async () => {
    const projectRoot = await makeValidationProjectRoot("resume-demo", {
        classification: "PLANNED_CHANGE",
        status: "implemented",
        executionMode: "non_git_in_place",
    });
    try {
        const first = await loadPlan(projectRoot, "resume-demo");
        assertExists(first);
        await updatePlanFrontMatter(
            projectRoot,
            "resume-demo",
            {
                validationCheckpoint: {
                    version: 1,
                    attemptId: "in-place",
                    generation: "saved-generation",
                    expectedStatus: "implemented",
                    nextPhase: "mechanical",
                    state: "paused",
                    updatedAt: "2026-08-13T00:00:00.000Z",
                },
            },
            {},
            { expectedRevision: first.revision },
        );
        const reopened = await loadPlan(projectRoot, "resume-demo");
        assertExists(reopened);
        assertEquals(reopened.attrs.validationCheckpoint?.generation, "saved-generation");
        assertEquals(reopened.attrs.status, "implemented");
    } finally {
        await Deno.remove(projectRoot, { recursive: true }).catch(() => {});
    }
});
