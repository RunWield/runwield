import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { withProcessGlobalTestLock } from "../../testing/process-global-lock.ts";
import { loadPlan } from "../../plan-store.js";
import { resolveProjectRuntimeLayout } from "../project-runtime-layout.ts";
import { RUNWIELD_GITIGNORE_BLOCK } from "../runwield-owned-paths.ts";
import { loadAttachedWorkflowRecord, locateAttachedWorkflows } from "./record-store.ts";
import {
    activateInput,
    type PendingPlanning,
    pendingTriage,
    planWrittenInput,
    type PlanWrittenInputOptions,
    reachPlanning,
    readRecordBytes,
    rejectionCode,
    runOperation,
    spawnAttachedCli,
    triageReportInput,
    withProject,
} from "./attached-test-fixture.ts";

const PLAN_MARKDOWN = "# Dark mode toggle\n\n## Implementation Steps\n\n1. Add the toggle.\n";

async function writePlan(projectRoot: string, planName = "dark-mode-toggle", markdown = PLAN_MARKDOWN) {
    const path = join(projectRoot, "docs", "plans", `${planName}.md`);
    await Deno.mkdir(join(path, ".."), { recursive: true });
    await Deno.writeTextFile(path, markdown);
    return path;
}

async function exists(path: string): Promise<boolean> {
    return await Deno.stat(path).then(() => true, () => false);
}

function submit(projectRoot: string, options: PlanWrittenInputOptions) {
    return runOperation("plan_written", projectRoot, planWrittenInput(options));
}

Deno.test("plan_written turns the written Plan into a draft RunWield Plan and records its reference", async () => {
    await withProcessGlobalTestLock(async () => {
        const sandboxHome = Deno.env.get("WLD_TEST_SANDBOX_HOME");
        const home = Deno.env.get("HOME");
        const temporaryHome = await Deno.makeTempDir({ prefix: "runwield-plan-home-" });
        Deno.env.set("HOME", temporaryHome);
        Deno.env.delete("WLD_TEST_SANDBOX_HOME");
        try {
            await withProject(async (projectRoot) => {
                assertEquals(await exists(join(projectRoot, ".wld")), false);
                const { result: triaged, planning } = await reachPlanning(projectRoot);
                assert(triaged.ok && triaged.workflow.nextAction.kind === "plan");
                assertEquals(triaged.workflow.nextAction.projectSetup, [".wld/internal/", ".gitignore"]);
                await writePlan(projectRoot);

                const result = await submit(projectRoot, {
                    ...planning,
                    executionAgent: "engineer",
                    collaborationRecommendation: "pair",
                });
                assert(result.ok, JSON.stringify(result));
                assertEquals(result.workflow.state, "awaiting_review");
                assertEquals(result.workflow.revision, planning.expectedRevision + 1);
                assertEquals(result.workflow.nextAction, { kind: "review", round: 1, planName: "dark-mode-toggle" });
                assertEquals(result.instructions, undefined);

                const plan = await loadPlan(projectRoot, "dark-mode-toggle");
                assert(plan, "Core must find the submitted Plan.");
                assertEquals(result.workflow.plan, { planId: plan.attrs.planId, planName: "dark-mode-toggle" });
                assertEquals(plan.attrs.status, "draft");
                assertEquals(plan.attrs.classification, "PLANNED_CHANGE");
                assertEquals(plan.attrs.workKind, "FEATURE");
                assertEquals(plan.attrs.complexity, "MEDIUM");
                assertEquals(plan.attrs.executionAgent, "engineer");
                assertEquals(plan.attrs.collaborationRecommendation, "pair");
                assertStringIncludes(plan.body, "1. Add the toggle.");

                assert(await exists(resolveProjectRuntimeLayout(projectRoot).primary.internalRoot));
                assertStringIncludes(
                    await Deno.readTextFile(join(projectRoot, ".gitignore")),
                    RUNWIELD_GITIGNORE_BLOCK,
                );
                const another = pendingTriage(
                    await runOperation("activate", projectRoot, activateInput("op-next-request")),
                );
                const next = await runOperation("triage_report", projectRoot, triageReportInput(another));
                assert(next.ok && next.workflow.nextAction.kind === "plan");
                assertEquals(next.workflow.nextAction.projectSetup, []);
            });
        } finally {
            if (sandboxHome !== undefined) Deno.env.set("WLD_TEST_SANDBOX_HOME", sandboxHome);
            if (home === undefined) Deno.env.delete("HOME");
            else Deno.env.set("HOME", home);
            await Deno.remove(temporaryHome, { recursive: true });
        }
    });
});

Deno.test("a fresh process retrieves the durable pending review before a browser is opened", async () => {
    await withProject(async (projectRoot) => {
        const { planning } = await reachPlanning(projectRoot);
        await writePlan(projectRoot);
        const submitted = await submit(projectRoot, planning);
        assert(submitted.ok);
        const plan = await loadPlan(projectRoot, "dark-mode-toggle");
        assert(plan);
        const loaded = await loadAttachedWorkflowRecord(locateAttachedWorkflows(projectRoot), planning.workflowId);
        assert(loaded.status === "found");
        const review = loaded.record.review;
        assert(review);
        assertEquals(loaded.record.state, "awaiting_review");
        assertEquals(loaded.record.pendingAction, null);
        assertEquals(review.round, 1);
        assert(review.actionId.length > 0);
        assertEquals(review.planRevision, plan.revision);
        assertEquals(review.waitingReason, "user_decision");
        assertEquals(review.status, "pending");
        assertEquals(review.outcome, undefined);

        const recordBeforeStatus = await readRecordBytes(projectRoot, planning.workflowId);
        const fresh = await spawnAttachedCli("status", projectRoot, { workflowId: planning.workflowId });
        assertEquals(fresh.code, 0, fresh.stderr);
        assert(fresh.result.ok);
        assertEquals(fresh.result.workflow.review, review);
        assertEquals(fresh.result.workflow.nextAction, { kind: "review", round: 1, planName: "dark-mode-toggle" });
        assertEquals(await readRecordBytes(projectRoot, planning.workflowId), recordBeforeStatus);
    });
});

Deno.test("the planning action lists the setup paths that plan_written then creates", async () => {
    await withProject(async (projectRoot) => {
        const { result: triaged, planning } = await reachPlanning(projectRoot);
        assert(triaged.ok && triaged.workflow.nextAction.kind === "plan");
        assertEquals(triaged.workflow.nextAction.projectSetup.includes(".gitignore"), true);

        await writePlan(projectRoot);
        assert((await submit(projectRoot, planning)).ok);
        assertEquals(await exists(join(projectRoot, ".gitignore")), true);
    });
});

interface RejectionCase {
    name: string;
    code: string;
    arrange: (projectRoot: string, planning: PendingPlanning) => Promise<PlanWrittenInputOptions>;
}

const REJECTIONS: RejectionCase[] = [
    {
        name: "a missing Plan file",
        code: "invalid_outcome",
        arrange: (_root, planning) => Promise.resolve({ ...planning, planName: "never-written" }),
    },
    {
        name: "a reserved Epic artifact name",
        code: "invalid_outcome",
        arrange: async (root, planning) => {
            await writePlan(root, "epic/manual-qa");
            return { ...planning, planName: "epic/manual-qa" };
        },
    },
    {
        name: "an archived Plan name",
        code: "invalid_outcome",
        arrange: async (root, planning) => {
            await writePlan(root, "archived/dark-mode-toggle");
            return { ...planning, planName: "archived/dark-mode-toggle" };
        },
    },
    {
        name: "an invalid execution policy",
        code: "invalid_outcome",
        arrange: async (root, planning) => {
            await writePlan(root, "dark-mode-toggle", `---\nexecutionAgent: wizard\n---\n\n${PLAN_MARKDOWN}`);
            return planning;
        },
    },
    {
        name: "an action that is not pending",
        code: "action_superseded",
        arrange: async (root, planning) => {
            await writePlan(root);
            return { ...planning, actionId: "not-the-pending-action" };
        },
    },
    {
        name: "a stale revision",
        code: "revision_conflict",
        arrange: async (root, planning) => {
            await writePlan(root);
            return { ...planning, expectedRevision: planning.expectedRevision - 1 };
        },
    },
];

for (const rejectionCase of REJECTIONS) {
    Deno.test(`plan_written rejects ${rejectionCase.name} and changes neither the record nor the Plan`, async () => {
        await withProject(async (projectRoot) => {
            const { planning } = await reachPlanning(projectRoot);
            const options = await rejectionCase.arrange(projectRoot, planning);
            const planPath = join(projectRoot, "docs", "plans", `${options.planName ?? "dark-mode-toggle"}.md`);
            const planBefore = await Deno.readTextFile(planPath).catch(() => null);
            const recordBefore = await readRecordBytes(projectRoot, planning.workflowId);

            const result = await submit(projectRoot, options);
            assertEquals(rejectionCode(result), rejectionCase.code, JSON.stringify(result));
            assertEquals(await readRecordBytes(projectRoot, planning.workflowId), recordBefore);
            assertEquals(await Deno.readTextFile(planPath).catch(() => null), planBefore);

            const status = await runOperation("status", projectRoot, { workflowId: planning.workflowId });
            assert(status.ok);
            assertEquals(status.workflow.nextAction.kind, "plan", "The planning action stays pending.");
        });
    });
}

Deno.test("after a rejected submission, the Planner fixes the Plan and submits again", async () => {
    await withProject(async (projectRoot) => {
        const { planning } = await reachPlanning(projectRoot);
        const missing = await submit(projectRoot, { ...planning, operationId: "op-plan-written-1" });
        assertEquals(rejectionCode(missing), "invalid_outcome");
        assertStringIncludes(missing.ok ? "" : missing.rejection.message, "not found");

        await writePlan(projectRoot);
        const accepted = await submit(projectRoot, { ...planning, operationId: "op-plan-written-2" });
        assert(accepted.ok, JSON.stringify(accepted));
        assertEquals(accepted.workflow.state, "awaiting_review");
    });
});

Deno.test("a repeated plan_written returns the saved result and leaves the Plan file unchanged", async () => {
    await withProject(async (projectRoot) => {
        const { planning } = await reachPlanning(projectRoot);
        const planPath = await writePlan(projectRoot);
        const first = await submit(projectRoot, planning);
        assert(first.ok, JSON.stringify(first));
        const planAfterFirst = await Deno.readTextFile(planPath);
        const recordAfterFirst = await readRecordBytes(projectRoot, planning.workflowId);

        const repeated = await submit(projectRoot, planning);
        assertEquals(repeated, first);
        assertEquals(await Deno.readTextFile(planPath), planAfterFirst);
        assertEquals(await readRecordBytes(projectRoot, planning.workflowId), recordAfterFirst);
    });
});

Deno.test("concurrent Plan submissions change only the winning Plan", async () => {
    await withProject(async (projectRoot) => {
        const { planning } = await reachPlanning(projectRoot);
        const names = ["first-toggle", "second-toggle"];
        const paths = await Promise.all(names.map((name) => writePlan(projectRoot, name)));
        const results = await Promise.all(names.map((planName, index) =>
            submit(projectRoot, {
                ...planning,
                planName,
                operationId: `op-plan-race-${index}`,
            })
        ));
        assertEquals(results.filter((result) => result.ok).length, 1);
        const loser = results.findIndex((result) => !result.ok);
        assertEquals(rejectionCode(results[loser]), "revision_conflict");
        assertEquals(await Deno.readTextFile(paths[loser]), PLAN_MARKDOWN);
        const winner = results.findIndex((result) => result.ok);
        assertStringIncludes(await Deno.readTextFile(paths[winner]), "planId:");
        const replay = await submit(projectRoot, {
            ...planning,
            planName: names[winner],
            operationId: `op-plan-race-${winner}`,
        });
        assertEquals(replay, results[winner]);
    });
});
