import { assertEquals, assertStringIncludes } from "@std/assert";

import { setCustomSetting } from "../settings.js";
import { loadPlan, parsePlanFrontMatter, savePlan } from "../../plan-store.js";
import { defineGitFixture, git } from "../git-test-fixture.ts";
import { createGitPort } from "../git-port.ts";
import { resolveProjectRuntimeLayout } from "../project-runtime-layout.ts";
import { createWorkRecordMnemotecaFixture } from "../work-records/test-fixtures/mnemoteca-port.ts";
import { HostedSession } from "../session/hosted-session.js";
import { removeWorktreeGitArtifacts } from "../worktree.js";
import { createTestWorktreeAttempt, makeRepo } from "../worktree-test-helpers.ts";
import { createEngineValidationArgs, shouldContinueParentEpicAfterValidation } from "./validation.ts";
import { resolvePhaseContext } from "./validation-context.ts";
import { runPublicationPhase } from "./validation-publication.ts";
import { continueWorkflowValidation } from "./validation-supervisor.ts";
import { loadPublicationAttempt, startPublicationAttempt } from "./publication-machine.ts";
import {
    createValidationProgress,
    getCurrentValidationProgress,
    setCurrentValidationProgress,
} from "./validation-progress.ts";
import { createExecutionStartPorts } from "./execution-start.ts";
import { startActiveExecutionWorkflow } from "./workflow.js";
import {
    attachRecorder,
    makeRecordedSession,
    makeUi,
    makeValidationProjectRoot,
    NO_ISOLATED_AGENT_PORT,
    runValidationLoop,
    runValidationPhase,
} from "./validation-test-helpers.js";

const footerExecutionRepo = defineGitFixture(async (repoPath) => {
    await savePlan(repoPath, "footer-plan", "# footer-plan\n\nvalidation fixture\n", {
        classification: "FEATURE",
        complexity: "MEDIUM",
        status: "ready_for_work",
        summary: "validation fixture",
        affectedPaths: [],
    });
    await git(repoPath, ["add", "."]);
    await git(repoPath, ["commit", "-m", "fixture base"]);
});

function makeValidationUi() {
    const uiAPI = makeUi();
    return { uiAPI, hostedSession: makeRecordedSession("validation-core-test", uiAPI) };
}

/**
 * @param {"implemented" | "validated_ci" | "reviewed"} status
 * @param {Record<string, string | number | null>} [attrs]
 */
async function makeLifecycleRun(status, attrs = {}) {
    const projectRoot = await makeValidationProjectRoot("p", {
        classification: "QUICK_FIX",
        status,
        ...attrs,
    });
    const { hostedSession } = makeValidationUi();
    /** @type {import('../../tools/plan-written.ts').TriageMeta} */
    const triageMeta = { classification: "QUICK_FIX", status, ...attrs };
    hostedSession.setWorkflowExecutionContext({
        planName: "p",
        triageMeta,
    });
    hostedSession.setActiveExecutionWorkflow({
        planName: "p",
        triageMeta,
        executionAgent: "engineer",
        projectRoot,
        executionCwd: projectRoot,
        nonGitInPlace: true,
    });
    return { projectRoot, hostedSession };
}

async function makePlannedReviewWorktree() {
    const projectRoot = await makeRepo();
    await setCustomSetting("codereview", "none", "project", projectRoot);
    await savePlan(projectRoot, "p", "# p\n\nvalidation fixture\n", {
        classification: "FEATURE",
        status: "validated_ci",
        summary: "validation fixture",
        affectedPaths: [],
    });
    await git(projectRoot, ["add", "."]);
    await git(projectRoot, ["commit", "-m", "add validation plan"]);

    const worktreeRoot = await Deno.makeTempDir({ prefix: "runwield-validation-worktree-" });
    const worktree = await createTestWorktreeAttempt({
        projectRoot,
        planName: "p",
        worktreeRoot,
    });
    const uiAPI = makeUi();
    const hostedSession = attachRecorder(
        new HostedSession({ id: "validation-worktree-test", cwd: projectRoot }),
        uiAPI,
    );
    hostedSession.setActiveExecutionWorkflow({
        planName: "p",
        triageMeta: { classification: "FEATURE", status: "validated_ci" },
        executionAgent: "engineer",
        projectRoot,
        executionCwd: worktree.path,
        executionMode: "worktree",
        baselineTree: worktree.baseTree,
        worktreeId: worktree.id,
        worktreeBranch: worktree.branch,
        worktreeBaseBranch: worktree.baseBranch,
    });
    return {
        projectRoot,
        worktree,
        executionCwd: worktree.path,
        hostedSession,
        uiAPI,
        cleanup: async () => {
            await removeWorktreeGitArtifacts({ projectRoot, path: worktree.path, force: true }).catch(() => {});
            await Deno.remove(projectRoot, { recursive: true }).catch(() => {});
            await Deno.remove(worktreeRoot, { recursive: true }).catch(() => {});
        },
    };
}

for (const interruption of ["abandoned catalog lock", "Git commit hook"]) {
    Deno.test({
        name: `publication resumes reviewed work after ${interruption} and presents a pause only once`,
        ignore: Deno.build.os === "windows",
        async fn() {
            const fixture = await makePlannedReviewWorktree();
            let obstruction = "";
            try {
                const plan = await loadPlan(fixture.executionCwd, "p");
                if (!plan) throw new Error("Missing execution Plan");
                await savePlan(fixture.executionCwd, "p", plan.body, {
                    ...plan.attrs,
                    status: "reviewed",
                    humanReviewMode: "none",
                    humanReviewDecision: "not_required",
                }, { expectedRevision: plan.revision });
                await Deno.writeTextFile(`${fixture.executionCwd}/delivered.txt`, "reviewed implementation\n");
                const mainBefore = await git(fixture.projectRoot, ["rev-parse", "main"]);
                if (interruption === "abandoned catalog lock") {
                    obstruction = resolveProjectRuntimeLayout(fixture.projectRoot).selected.planCatalogLockPath;
                    const past = new Date(Date.now() - 60_000);
                    await Deno.writeTextFile(
                        obstruction,
                        JSON.stringify({
                            token: "abandoned-by-live-workspace",
                            pid: Deno.pid,
                            hostname: Deno.hostname(),
                            updatedAtMs: past.getTime(),
                        }),
                    );
                    await Deno.utime(obstruction, past, past);
                } else {
                    obstruction = `${fixture.projectRoot}/.git/hooks/pre-commit`;
                    await Deno.writeTextFile(obstruction, "#!/bin/sh\necho 'commit hook rejected' >&2\nexit 1\n");
                    await Deno.chmod(obstruction, 0o755);
                }
                setCurrentValidationProgress(
                    fixture.hostedSession,
                    createValidationProgress({
                        kind: "workflow",
                        outcome: "running",
                        stage: "merge",
                        cycle: 1,
                        maxCycles: 3,
                        checks: { ci: "passed", semanticReview: "passed", humanReview: "skipped", merge: "running" },
                    }),
                );
                const result = await continueWorkflowValidation({
                    hostedSession: fixture.hostedSession,
                    planName: "p",
                    planContent: plan.body,
                    triageMeta: { classification: "FEATURE", status: "reviewed" },
                    git: createGitPort(),
                    localCI: { run: () => Promise.reject(new Error("Completed CI must not run again")) },
                    workRecordMnemotecaPort: createWorkRecordMnemotecaFixture(),
                    semanticReviewPort: NO_ISOLATED_AGENT_PORT,
                });
                if (interruption === "abandoned catalog lock") {
                    assertEquals(
                        result.kind,
                        "verified",
                        JSON.stringify({
                            result,
                            publication: await loadPublicationAttempt(fixture.projectRoot, fixture.worktree.id),
                        }),
                    );
                    assertEquals(
                        await git(fixture.projectRoot, ["show", "main:delivered.txt"]),
                        "reviewed implementation",
                    );
                } else {
                    assertEquals(result.kind, "paused", JSON.stringify(result));
                    assertStringIncludes(result.reason || "", "Fix the Git hook or commit error");
                    assertEquals(
                        fixture.uiAPI.messages.filter((/** @type {string} */ message) => message === result.reason)
                            .length,
                        1,
                    );
                    assertEquals(getCurrentValidationProgress(fixture.hostedSession)?.outcome, "paused");
                    assertEquals(await git(fixture.projectRoot, ["rev-parse", "main"]), mainBefore);
                    assertEquals((await loadPlan(fixture.executionCwd, "p"))?.attrs.status, "reviewed");
                    assertEquals(
                        await Deno.readTextFile(`${fixture.executionCwd}/delivered.txt`),
                        "reviewed implementation\n",
                    );
                }
            } finally {
                if (obstruction) await Deno.remove(obstruction).catch(() => {});
                await fixture.cleanup();
            }
        },
    });
}

for (const sealed of [false, true]) {
    Deno.test(`publication rereads a target edited after phase resolution (sealed: ${sealed})`, async () => {
        const fixture = await makePlannedReviewWorktree();
        try {
            const { projectRoot, worktree } = fixture;
            await git(projectRoot, ["branch", "release/next"]);
            const mainBefore = await git(projectRoot, ["rev-parse", "main"]);
            const args = createEngineValidationArgs({
                hostedSession: fixture.hostedSession,
                planName: "p",
                planContent: "# stale Plan",
                triageMeta: { classification: "FEATURE", status: "reviewed", targetBranch: "main" },
                git: createGitPort(),
                localCI: { run: () => Promise.reject(new Error("Unexpected CI")) },
                workRecordMnemotecaPort: createWorkRecordMnemotecaFixture(),
                semanticReviewPort: NO_ISOLATED_AGENT_PORT,
            });
            const phase = await resolvePhaseContext(args);
            if (phase.kind !== "ok") throw new Error("Missing phase context");
            assertEquals(phase.context.worktreeBaseBranch, "main");
            if (sealed) {
                await startPublicationAttempt({
                    projectRoot,
                    attemptId: worktree.id,
                    planName: "p",
                    targetBranch: "main",
                    executionBranch: worktree.branch,
                    executionCwd: worktree.path,
                    validatedCommit: mainBefore,
                    targetHeadAtSeal: mainBefore,
                });
            }
            const plan = await loadPlan(worktree.path, "p");
            if (!plan) throw new Error("Missing execution Plan");
            await savePlan(worktree.path, "p", plan.body, {
                ...plan.attrs,
                status: "reviewed",
                targetBranch: "release/next",
            }, { expectedRevision: plan.revision });
            await Deno.writeTextFile(`${worktree.path}/delivered.txt`, "late target edit\n");
            const result = await runPublicationPhase(args, phase.context, {
                humanReviewMode: "none",
                humanReviewDecision: "not_required",
                humanReviewedAt: null,
            });
            assertEquals(await git(projectRoot, ["rev-parse", "main"]), mainBefore);
            if (sealed) {
                assertEquals(result.result.kind, "paused");
                assertStringIncludes(result.result.reason || "", "Plan now targets release/next");
                assertEquals(await git(projectRoot, ["rev-parse", "release/next"]), mainBefore);
                assertEquals((await loadPublicationAttempt(projectRoot, worktree.id))?.targetBranch, "main");
                assertEquals(await Deno.readTextFile(`${worktree.path}/delivered.txt`), "late target edit\n");
            } else {
                assertEquals(result.result.kind, "verified", JSON.stringify(result));
                assertEquals(await git(projectRoot, ["show", "release/next:delivered.txt"]), "late target edit");
            }
        } finally {
            await fixture.cleanup();
        }
    });
}

for (const targetBranch of ["release/next", " origin/release/next ", undefined]) {
    Deno.test(`delivery rereads the execution Plan target: ${targetBranch ?? "recorded default"}`, async () => {
        const fixture = await makePlannedReviewWorktree();
        try {
            await git(fixture.projectRoot, ["branch", "release/next"]);
            const mainBefore = await git(fixture.projectRoot, ["rev-parse", "main"]);
            const plan = await loadPlan(fixture.executionCwd, "p");
            if (!plan) throw new Error("Missing execution Plan");
            // The Session, registry and primary Plan still describe the old target.
            // Only the execution document changes after the workflow was loaded.
            await savePlan(fixture.executionCwd, "p", plan.body, {
                ...plan.attrs,
                status: "reviewed",
                targetBranch,
                humanReviewMode: "none",
                humanReviewDecision: "not_required",
            }, { expectedRevision: plan.revision });
            await Deno.writeTextFile(`${fixture.executionCwd}/delivered.txt`, "selected target\n");
            setCurrentValidationProgress(
                fixture.hostedSession,
                createValidationProgress({
                    kind: "workflow",
                    outcome: "failed",
                    stage: "terminal",
                    cycle: 1,
                    maxCycles: 3,
                    checks: { ci: "failed", semanticReview: "canceled", humanReview: "canceled", merge: "failed" },
                }),
            );
            const result = await runValidationLoop({
                hostedSession: fixture.hostedSession,
                planName: "p",
                planContent: "# stale Plan",
                triageMeta: { classification: "FEATURE", status: "validated_ci", targetBranch: "main" },
                git: createGitPort(),
                workRecordMnemotecaPort: createWorkRecordMnemotecaFixture(),
                semanticReviewPort: NO_ISOLATED_AGENT_PORT,
            });
            assertEquals(result.kind, "verified", JSON.stringify(result));
            assertEquals(getCurrentValidationProgress(fixture.hostedSession)?.checks, {
                ci: "passed",
                semanticReview: "passed",
                humanReview: "skipped",
                merge: "passed",
            });
            assertEquals(getCurrentValidationProgress(fixture.hostedSession)?.outcome, "verified");
            assertEquals(await loadPublicationAttempt(fixture.projectRoot, fixture.worktree.id), null);
            assertEquals(fixture.uiAPI.messages.join("\n").includes("could not finish adding"), false);
            const expectedTarget = targetBranch ? "release/next" : "main";
            assertEquals(
                await git(fixture.projectRoot, ["show", `${expectedTarget}:delivered.txt`]),
                "selected target",
            );
            const publishedPlan = await git(fixture.projectRoot, ["show", `${expectedTarget}:docs/plans/p.md`]);
            assertEquals(parsePlanFrontMatter(publishedPlan).attrs.targetBranch, expectedTarget);
            if (targetBranch) {
                assertEquals(await git(fixture.projectRoot, ["rev-parse", "main"]), mainBefore);
                assertEquals(
                    fixture.uiAPI.messages.join("\n").includes("Merging work into main"),
                    false,
                );
            }
        } finally {
            await fixture.cleanup();
        }
    });
}

Deno.test("startActiveExecutionWorkflow seeds footer workflow context from Plan front matter", async () => {
    const projectRoot = await footerExecutionRepo.checkout({ prefix: "footer-context-start-" });
    const plan = await loadPlan(projectRoot, "footer-plan");
    const uiAPI = makeUi();
    const hostedSession = attachRecorder(
        new HostedSession({ id: "footer-context-start-test", cwd: projectRoot }),
        uiAPI,
    );

    await startActiveExecutionWorkflow({
        planName: "footer-plan",
        triageMeta: plan?.attrs || {},
        currentStatus: "ready_for_work",
        hostedSession,
        ports: createExecutionStartPorts(),
    });

    const workflowContext = hostedSession.getWorkflowContext();
    assertEquals(typeof workflowContext?.planId, "string");
    assertEquals({ ...workflowContext, planId: "<generated>" }, {
        routingIntent: "PLANNED_CHANGE",
        complexity: "MEDIUM",
        planName: "footer-plan",
        planId: "<generated>",
        status: "ready_for_work",
    });
    assertEquals(hostedSession.getActiveExecutionWorkflow()?.executionAgent, "engineer");
});

Deno.test("shouldContinueParentEpicAfterValidation detects parent epic linkage", () => {
    assertEquals(shouldContinueParentEpicAfterValidation({ classification: "FEATURE" }), false);
    assertEquals(
        shouldContinueParentEpicAfterValidation({ classification: "FEATURE", parentPlan: "" }),
        false,
    );
    assertEquals(
        shouldContinueParentEpicAfterValidation({ classification: "FEATURE", parentPlan: "epic" }),
        true,
    );
});

Deno.test("shouldContinueParentEpicAfterValidation ignores standalone FEATURE plans", async () => {
    const { projectRoot, hostedSession } = await makeLifecycleRun("reviewed", {
        classification: "FEATURE",
        humanReviewMode: "none",
        humanReviewDecision: "not_required",
    });
    hostedSession.setActiveExecutionWorkflow({
        planName: "p",
        triageMeta: {
            classification: "FEATURE",
            status: "reviewed",
            humanReviewMode: "none",
            humanReviewDecision: "not_required",
        },
        executionAgent: "engineer",
        projectRoot,
        executionCwd: projectRoot,
        nonGitInPlace: true,
    });

    const result = await runValidationLoop({
        hostedSession,
        planName: "p",
        planContent: "# p",
        triageMeta: {
            classification: "FEATURE",
            status: "reviewed",
            humanReviewMode: "none",
            humanReviewDecision: "not_required",
        },
        semanticReviewPort: NO_ISOLATED_AGENT_PORT,
    });

    const plan = await loadPlan(projectRoot, "p");
    assertEquals(result.kind, "verified");
    assertEquals(result.epicContinuation, undefined);
    assertEquals(plan?.attrs.status, "verified");
    assertEquals(plan?.attrs.deliveryEvidence, { version: 1, mode: "non_git_in_place" });
});

Deno.test("runValidationLoop shows why FEATURE validation fails when workflow diff is empty", async () => {
    const { executionCwd, hostedSession, uiAPI, cleanup } = await makePlannedReviewWorktree();
    try {
        const result = await runValidationLoop({
            hostedSession,
            planName: "p",
            planContent: "# p",
            triageMeta: { classification: "FEATURE", status: "validated_ci" },
            semanticReviewPort: NO_ISOLATED_AGENT_PORT,
        });

        const plan = await loadPlan(executionCwd, "p");
        assertEquals(result.kind, "failed");
        assertStringIncludes(result.reason || "", "No implementation changes detected");
        assertEquals(plan?.attrs.status, "implemented");
        const messages = /** @type {string[]} */ (uiAPI.messages);
        assertEquals(
            messages.some((message) => message.includes("Ask the Engineer to restore the code")),
            true,
        );
    } finally {
        await cleanup();
    }
});

Deno.test("runValidationLoop fails PROJECT validation when workflow diff only changes a plan document", async () => {
    const { projectRoot, hostedSession } = await makeLifecycleRun("validated_ci", { classification: "PROJECT" });
    await git(projectRoot, ["init", "-b", "main"]);
    await git(projectRoot, ["config", "user.email", "runwield@example.com"]);
    await git(projectRoot, ["config", "user.name", "RunWield Test"]);
    await git(projectRoot, ["add", "."]);
    await git(projectRoot, ["commit", "-m", "validation baseline"]);
    const baselineTree = await git(projectRoot, ["rev-parse", "HEAD^{tree}"]);
    const baselinePlan = await loadPlan(projectRoot, "p");
    await savePlan(projectRoot, "p", "# p\n\nPlan-only follow-up.\n", {
        classification: "PROJECT",
        status: "validated_ci",
        summary: "validation fixture",
        affectedPaths: [],
    }, { expectedRevision: baselinePlan?.revision });
    hostedSession.setActiveExecutionWorkflow({
        planName: "p",
        triageMeta: { classification: "PROJECT", status: "validated_ci" },
        executionAgent: "engineer",
        projectRoot,
        executionCwd: projectRoot,
        executionMode: "worktree",
        baselineTree,
        worktreeId: "wt1",
        worktreeBranch: "runwield/worktree/p-wt1",
        worktreeBaseBranch: "main",
    });

    const result = await runValidationLoop({
        hostedSession,
        planName: "p",
        planContent: "# p",
        triageMeta: { classification: "PROJECT", status: "validated_ci" },
        semanticReviewPort: NO_ISOLATED_AGENT_PORT,
    });

    const plan = await loadPlan(projectRoot, "p");
    assertEquals(result.kind, "failed");
    assertStringIncludes(result.reason || "", "only plan document changes");
    assertEquals(plan?.attrs.status, "implemented");
});

Deno.test("runValidationLoop starts at implemented and records only the mechanical pass boundary", async () => {
    const expectedWorkflowContext = {
        routingIntent: "QUICK_FIX",
        complexity: "MEDIUM",
        planName: "p",
        status: "implemented",
    };
    const { projectRoot, hostedSession } = await makeLifecycleRun("implemented", { complexity: "MEDIUM" });
    let ciCalls = 0;
    assertEquals(hostedSession.getWorkflowContext(), expectedWorkflowContext);

    const result = await runValidationPhase({
        hostedSession,
        planName: "p",
        planContent: "# p",
        triageMeta: { classification: "QUICK_FIX", status: "implemented", complexity: "MEDIUM" },
        semanticReviewPort: NO_ISOLATED_AGENT_PORT,
        localCI: {
            run: () => {
                ciCalls += 1;
                return Promise.resolve({ kind: "completed", exitCode: 0, output: "ok" });
            },
        },
    });

    const plan = await loadPlan(projectRoot, "p");
    assertEquals(ciCalls, 1);
    assertEquals(result.kind, "paused");
    assertEquals(hostedSession.getWorkflowContext(), expectedWorkflowContext);
    assertEquals(plan?.attrs.status, "implemented");
    assertEquals(plan?.attrs.validationPhase, "semantic");
    assertEquals(plan?.attrs.validationCiAttempts, 0);
});
