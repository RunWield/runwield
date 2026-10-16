import {
    mkdir as fsMkdir,
    mkdtemp as fsMkdtemp,
    readFile as fsReadFile,
    rm as fsRm,
    writeFile as fsWriteFile,
} from "node:fs/promises";
import { test } from "node:test";
import { tmpdir } from "node:os";
import { assertEquals, assertStringIncludes } from "../../testing/assertions.ts";
import { join } from "node:path";
import { HostedSession } from "../session/hosted-session.js";
import { createGitPort } from "../git-port.ts";
import { createPlanDeviationTool } from "../../tools/plan-deviation.ts";
import { loadPlan, savePlan } from "../../plan-store.js";
import { defineCommittedGitFixture, git } from "../git-test-fixture.ts";
import { executeWorkflowTestTools } from "../../testing/workflow-agent-tools.ts";
import { runValidationPhase } from "./validation.ts";
import { createWorkRecordMnemotecaFixture } from "../work-records/test-fixtures/mnemoteca-port.ts";
import { findWorkRecordById, generateWorkRecordForSource, previewWorkRecordBackfill } from "../work-records/index.ts";
import type { RuntimeInteractionRequest } from "../session/session-runtime-interactions.js";
import type { IsolatedAgentSessionOptions } from "./validation-session-adapter.ts";

const FIXTURE = defineCommittedGitFixture({
    "README.md": "# Fixture\n",
});

type PlanDeviationTool = ReturnType<typeof createPlanDeviationTool>;
type PlanDeviationToolContext = Parameters<PlanDeviationTool["execute"]>[4];

async function executeDeviation(tool: PlanDeviationTool) {
    const context = {} as PlanDeviationToolContext;
    return await tool.execute(
        "deviation-call-1",
        {
            supersededRequirement: "Replace the existing navigation.",
            replacementRequirement: "Keep the existing navigation.",
            reason: "The user confirmed the direction during Pair Execution.",
        },
        undefined,
        undefined,
        context,
    );
}

test("confirmed Pair Plan Deviation survives restart, review, and Work Record backfill", async () => {
    const projectRoot = await FIXTURE.checkout({ prefix: "runwield-plan-deviation-primary-" });
    const executionRoot = await fsMkdtemp(join(tmpdir(), "runwield-plan-deviation-worktree-"));
    await fsRm(executionRoot, { recursive: true });
    try {
        await git(projectRoot, ["worktree", "add", "-b", "worktree/navigation", executionRoot, "HEAD"]);
        await fsMkdir(join(executionRoot, "src"), { recursive: true });
        await fsWriteFile(join(executionRoot, "src", "app.js"), "export const nav = 'replace';\n");
        await savePlan(executionRoot, "navigation", "# Navigation\n\nReplace the existing navigation.", {
            planId: "plan-navigation",
            classification: "PLANNED_CHANGE",
            workKind: "FEATURE",
            complexity: "LOW",
            summary: "Navigation fixture.",
            affectedPaths: ["src/app.js"],
            createdAt: "2026-09-10T00:00:00.000Z",
            status: "validated_ci",
            executionAgent: "engineer",
            collaborationRecommendation: "pair",
        });
        await git(executionRoot, ["add", "."]);
        await git(executionRoot, ["commit", "-m", "validation baseline"]);
        const baselineTree = await git(executionRoot, ["rev-parse", "HEAD^{tree}"]);
        const baselineCommit = await git(executionRoot, ["rev-parse", "HEAD"]);
        await fsWriteFile(join(executionRoot, "src", "app.js"), "export const nav = 'keep';\n");

        const pairRequests: RuntimeInteractionRequest[] = [];
        const pairSession = new HostedSession({
            id: `plan-deviation-pair-${crypto.randomUUID()}`,
            cwd: projectRoot,
            interactionAdapter: {
                supportsInteraction: (type) => type === "plan_deviation_confirmation",
                requestInteraction: (request) => {
                    pairRequests.push(request);
                    return { outcome: "accepted", value: true };
                },
            },
        });
        pairSession.setActiveExecutionWorkflow({
            planName: "navigation",
            triageMeta: { classification: "PLANNED_CHANGE", workKind: "FEATURE", status: "validated_ci" },
            executionAgent: "engineer",
            executionStarted: true,
            collaborationStyle: "pair",
            collaborationRecommendation: "pair",
            projectRoot,
            executionCwd: executionRoot,
            executionMode: "worktree",
            worktreeId: "attempt-navigation",
            worktreeBranch: "worktree/navigation",
            worktreeBaseBranch: "main",
            worktreeBaseCommit: baselineCommit,
            baselineTree,
        });

        const deviation = await executeDeviation(createPlanDeviationTool({ hostedSession: pairSession }));
        assertEquals(deviation.details.decision, "recorded");
        const planMarkdown = await fsReadFile(join(executionRoot, "docs", "plans", "navigation.md"), "utf8");
        assertStringIncludes(planMarkdown, "planDeviations:");
        assertStringIncludes(planMarkdown, 'replacementRequirement: "Keep the existing navigation."');
        pairSession.dispose();

        const reviewPrompts: string[] = [];
        const validationSession = new HostedSession({
            id: `plan-deviation-validation-${crypto.randomUUID()}`,
            cwd: projectRoot,
        });
        validationSession.setActiveExecutionWorkflow({
            planName: "navigation",
            triageMeta: { classification: "PLANNED_CHANGE", workKind: "FEATURE", status: "validated_ci" },
            executionAgent: "engineer",
            executionStarted: true,
            projectRoot,
            executionCwd: executionRoot,
            executionMode: "worktree",
            worktreeId: "attempt-navigation",
            worktreeBranch: "worktree/navigation",
            worktreeBaseBranch: "main",
            worktreeBaseCommit: baselineCommit,
            baselineTree,
        });
        const loadedForValidation = await loadPlan(executionRoot, "navigation");
        if (!loadedForValidation) throw new Error("Plan disappeared before validation.");

        const phase = await runValidationPhase({
            hostedSession: validationSession,
            planName: "navigation",
            planContent: loadedForValidation.markdown,
            triageMeta: {
                classification: "PLANNED_CHANGE",
                workKind: "FEATURE",
                status: "validated_ci",
            },
            git: createGitPort(),
            localCI: {
                run: () => Promise.reject(new Error("Semantic-only phase must not run CI.")),
            },
            semanticReviewPort: {
                runIsolatedAgentSession: async (options: IsolatedAgentSessionOptions) => {
                    reviewPrompts.push(options.userRequest);
                    await executeWorkflowTestTools(options, [
                        { name: "review_diff", arguments: { command: "list", scope: "full" } },
                        { name: "review_complete", arguments: { approved: true, findings: [], advisories: [] } },
                    ]);
                    return [];
                },
            },
            workRecordMnemotecaPort: createWorkRecordMnemotecaFixture(),
        });
        assertEquals(phase.kind, "paused");
        assertStringIncludes(reviewPrompts[0], "## Approved Plan Deviations");
        assertStringIncludes(reviewPrompts[0], "Replacement requirement: Keep the existing navigation.");
        validationSession.dispose();

        const readyForRecord = await loadPlan(executionRoot, "navigation");
        if (!readyForRecord) throw new Error("Plan disappeared before record generation.");
        await savePlan(
            executionRoot,
            "navigation",
            readyForRecord.markdown,
            { status: "verified" },
            { expectedRevision: readyForRecord.revision },
        );
        const source = (await previewWorkRecordBackfill(executionRoot)).eligible.find((candidate) =>
            candidate.name === "navigation"
        );
        if (!source) throw new Error("Work Record backfill did not discover the verified Plan.");
        const outcome = await generateWorkRecordForSource(executionRoot, source, {
            mnemotecaPort: createWorkRecordMnemotecaFixture(),
            idGenerator: () => "99999999-9999-4999-8999-999999999999",
            now: () => new Date("2026-09-10T00:00:00.000Z"),
            runRecorderStep: () =>
                Promise.resolve({
                    title: "Navigation Deviation",
                    summary: "Completed the confirmed navigation direction.",
                }),
        });
        assertEquals(outcome.status, "generated");
        const record = await findWorkRecordById(executionRoot, "99999999-9999-4999-8999-999999999999");
        assertStringIncludes(
            record?.sections["Deviations from Plan"] || "",
            "Superseded requirement: Replace the existing navigation.",
        );
        assertStringIncludes(
            record?.sections["Deviations from Plan"] || "",
            "Replacement requirement: Keep the existing navigation.",
        );
        assertStringIncludes(
            record?.sections["Deviations from Plan"] || "",
            "Reason: The user confirmed the direction during Pair Execution.",
        );
    } finally {
        try {
            await git(projectRoot, ["worktree", "remove", "--force", executionRoot]);
        } catch {
            try {
                await fsRm(executionRoot, { recursive: true });
            } catch { /* already gone */ }
        }
        await fsRm(projectRoot, { recursive: true });
    }
});
