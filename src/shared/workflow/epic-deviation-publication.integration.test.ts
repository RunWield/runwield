import { test } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { assertEquals, assertStringIncludes } from "../../testing/assertions.ts";
import { loadPlan, savePlan } from "../../plan-store.js";
import { createTestWorktreeAttempt, git, makeRepo } from "../worktree-test-helpers.ts";
import { createGitPort } from "../git-port.ts";
import { removeWorktreeGitArtifacts } from "../worktree.js";
import { HostedSession } from "../session/hosted-session.js";
import { createWorkRecordMnemotecaFixture } from "../work-records/test-fixtures/mnemoteca-port.ts";
import { executeWorkflowTestTools } from "../../testing/workflow-agent-tools.ts";
import { createEngineValidationArgs } from "./validation.ts";
import { resolvePhaseContext } from "./validation-context.ts";
import { runPublicationPhase } from "./validation-publication.ts";
import { loadPublicationAttempt } from "./publication-machine.ts";

// Both sync boundaries must run through the real publication phase, not a test-side sync call.
test("publication repairs the Epic projection before each candidate checkpoint", async () => {
    const projectRoot = await makeRepo();
    const worktreeRoot = await mkdtemp(join(tmpdir(), "epic-deviation-publication-"));
    const planName = "epic/01-child";
    await savePlan(projectRoot, "epic", "# Epic\n\n## Objective\n\nShip two outcomes.\n", {
        planId: "epic-parent",
        classification: "PROJECT",
        status: "ready_for_work",
        targetBranch: "epic/epic",
    });
    for (const order of [1, 2])
        await savePlan(projectRoot, `epic/0${order}-child`, "# Child\n", {
            planId: `child-${order}`,
            classification: "PLANNED_CHANGE",
            parentPlan: "epic",
            order,
            status: order === 1 ? "reviewed" : "draft",
            targetBranch: "epic/epic",
        });
    await git(projectRoot, ["add", "."]);
    await git(projectRoot, ["commit", "-m", "Epic family"]);
    await git(projectRoot, ["branch", "epic/epic"]);
    const primaryBefore = (await loadPlan(projectRoot, "epic"))!.markdown;
    const worktree = await createTestWorktreeAttempt({
        projectRoot,
        planName,
        planId: "child-1",
        worktreeRoot,
        baseRef: "epic/epic",
        baseBranch: "epic/epic",
    });
    const hostedSession = new HostedSession({ id: "publication-sync", cwd: projectRoot });
    hostedSession.setActiveExecutionWorkflow({
        planName,
        triageMeta: { classification: "PLANNED_CHANGE", status: "reviewed" },
        executionAgent: "engineer",
        projectRoot,
        executionCwd: worktree.path,
        executionMode: "worktree",
        worktreeId: worktree.id,
        worktreeBranch: worktree.branch,
        worktreeBaseBranch: worktree.baseBranch,
        baselineTree: worktree.baseTree,
    });
    let firstSeal = "";
    try {
        const child = (await loadPlan(worktree.path, planName))!;
        await savePlan(
            worktree.path,
            planName,
            child.markdown,
            {
                planDeviations: [
                    {
                        id: "approved",
                        supersededRequirement: "Ship two outcomes.",
                        replacementRequirement: "Ship one outcome.",
                        approvedAt: "2026-10-24T00:00:00.000Z",
                    },
                ],
            },
            { expectedRevision: child.revision },
        );
        const args = createEngineValidationArgs({
            hostedSession,
            planName,
            planContent: child.markdown,
            triageMeta: { classification: "PLANNED_CHANGE", status: "reviewed" },
            git: createGitPort(),
            localCI: { run: () => Promise.reject(new Error("Publication must not run CI")) },
            workRecordMnemotecaPort: createWorkRecordMnemotecaFixture(),
            semanticReviewPort: {
                runIsolatedAgentSession: async (options) => {
                    const attempt = await loadPublicationAttempt(projectRoot, worktree.id);
                    if (!attempt) throw new Error("Publication did not seal its first candidate.");
                    firstSeal = await git(worktree.path, ["show", `${attempt.validatedCommit}:docs/plans/epic.md`]);
                    // Lose the projection between checkpoints. The final seal must restore it.
                    await writeFile(join(worktree.path, "docs/plans/epic.md"), primaryBefore);
                    await executeWorkflowTestTools(options, [
                        {
                            name: "qa_checklist_generated",
                            arguments: {
                                checklistMarkdown: `Manual verification steps for ${planName}\n\n- [ ] Check the remaining outcome.`,
                            },
                        },
                    ]);
                    return [];
                },
            },
        });
        const phase = await resolvePhaseContext(args);
        if (phase.kind !== "ok") throw new Error("Missing publication context");
        const outcome = await runPublicationPhase(args, phase.context, {
            humanReviewMode: "none",
            humanReviewDecision: "not_required",
            humanReviewedAt: null,
        });
        assertEquals(outcome.result.kind, "verified", JSON.stringify(outcome));
        assertStringIncludes(firstSeal, "Replacement requirement: Ship one outcome.");
        assertStringIncludes(
            await git(projectRoot, ["show", "epic/epic:docs/plans/epic.md"]),
            "Replacement requirement: Ship one outcome.",
        );
        assertEquals(await readFile(join(projectRoot, "docs/plans/epic.md"), "utf8"), primaryBefore);
    } finally {
        hostedSession.dispose();
        await removeWorktreeGitArtifacts({ projectRoot, path: worktree.path, force: true }).catch(() => {});
        await rm(worktreeRoot, { recursive: true, force: true });
        await rm(projectRoot, { recursive: true, force: true });
    }
});
