import { mkdtemp as fsMkdtemp, rm as fsRm, writeFile as fsWriteFile } from "node:fs/promises";
import { test } from "node:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { assertEquals, assertStringIncludes } from "../../testing/assertions.ts";
import { HostedSession } from "../../shared/session/hosted-session.js";
import type {
    RuntimeInteractionRequest,
    RuntimeInteractionResponse,
} from "../../shared/session/session-runtime-interactions.js";
import { loadPlan, savePlan } from "../../plan-store.js";
import { createPlanDeviationTool } from "../plan-deviation.ts";

type PlanDeviationTool = ReturnType<typeof createPlanDeviationTool>;
type PlanDeviationToolContext = Parameters<PlanDeviationTool["execute"]>[4];

type PlanDeviationSessionFixture = {
    projectRoot: string;
    session: HostedSession;
    requests: RuntimeInteractionRequest[];
};

async function makePlan(projectRoot: string, planName = "demo-plan") {
    await savePlan(projectRoot, planName, "# Demo Plan\n\nOriginal body.", {
        classification: "PLANNED_CHANGE",
        workKind: "FEATURE",
        status: "in_progress",
        planId: "plan-deviation-test",
        executionAgent: "engineer",
        collaborationRecommendation: "pair",
    });
    const plan = await loadPlan(projectRoot, planName);
    if (!plan) throw new Error("Plan fixture was not saved.");
    return plan;
}

function makeSession(
    projectRoot: string,
    responses: RuntimeInteractionResponse[],
    supportsConfirmation = true,
): PlanDeviationSessionFixture {
    const requests: RuntimeInteractionRequest[] = [];
    const session = new HostedSession({
        id: `plan-deviation-${crypto.randomUUID()}`,
        cwd: projectRoot,
        interactionAdapter: {
            supportsInteraction: (type) => supportsConfirmation && type === "plan_deviation_confirmation",
            requestInteraction: (request) => {
                requests.push(request);
                return responses.shift() || { outcome: "unsupported" };
            },
        },
    });
    session.setActiveExecutionWorkflow({
        planName: "demo-plan",
        triageMeta: { classification: "PLANNED_CHANGE" },
        executionAgent: "engineer",
        executionStarted: true,
        collaborationStyle: "pair",
        collaborationRecommendation: "pair",
        projectRoot,
        executionCwd: projectRoot,
        executionMode: "worktree",
        worktreeId: "attempt-one",
        worktreeBranch: "worktree/demo",
    });
    return { projectRoot, session, requests };
}

async function executeDeviation(tool: PlanDeviationTool, callId: string) {
    const context = {} as PlanDeviationToolContext;
    return await tool.execute(
        callId,
        {
            supersededRequirement: "Replace the old navigation.",
            replacementRequirement: "Keep the existing navigation.",
            reason: "The user chose continuity during Pair Execution.",
        },
        undefined,
        undefined,
        context,
    );
}

async function withTempProject(fn: (projectRoot: string) => Promise<void>) {
    const projectRoot = await fsMkdtemp(join(tmpdir(), "runwield-plan-deviation-"));
    try {
        await fn(projectRoot);
    } finally {
        await fsRm(projectRoot, { recursive: true });
    }
}

test("record_plan_deviation confirms and appends one Plan-owned entry", async () => {
    await withTempProject(async (projectRoot) => {
        const before = await makePlan(projectRoot);
        const fixture = makeSession(projectRoot, [{ outcome: "accepted", value: true }]);
        const result = await executeDeviation(createPlanDeviationTool({ hostedSession: fixture.session }), "call-1");
        const after = await loadPlan(projectRoot, "demo-plan");
        if (!after) throw new Error("Plan disappeared.");

        assertEquals(result.details.decision, "recorded");
        assertEquals(result.terminate, false);
        assertEquals(after.body, before.body);
        assertEquals(after.attrs.status, "in_progress");
        assertEquals(after.attrs.planDeviations?.length, 1);
        assertEquals(after.attrs.planDeviations?.[0].id, "call-1");
        assertEquals(after.attrs.planDeviations?.[0].supersededRequirement, "Replace the old navigation.");
        assertEquals(after.attrs.planDeviations?.[0].replacementRequirement, "Keep the existing navigation.");
        assertStringIncludes(after.markdown, "planDeviations:");
        assertEquals(
            fixture.requests[0].prompt,
            [
                "Confirm this Plan Deviation before I treat it as authority.",
                "Superseded requirement: Replace the old navigation.",
                "Replacement requirement: Keep the existing navigation.",
                "Reason: The user chose continuity during Pair Execution.",
                "Confirmed text will be saved in the Plan and Work Record.",
            ].join("\n\n"),
        );
    });
});

test("record_plan_deviation is durable and idempotent after reload", async () => {
    await withTempProject(async (projectRoot) => {
        await makePlan(projectRoot);
        const first = makeSession(projectRoot, [{ outcome: "accepted", value: true }]);
        await executeDeviation(createPlanDeviationTool({ hostedSession: first.session }), "call-1");

        const second = makeSession(projectRoot, [{ outcome: "accepted", value: true }]);
        const result = await executeDeviation(createPlanDeviationTool({ hostedSession: second.session }), "call-1");
        const after = await loadPlan(projectRoot, "demo-plan");
        if (!after) throw new Error("Plan disappeared.");

        const entry = after.attrs.planDeviations?.[0];
        if (!entry) throw new Error("Expected one persisted deviation.");
        assertEquals(result.details, {
            decision: "recorded",
            entry,
            alreadyCommitted: true,
        });
        assertEquals(after.attrs.planDeviations?.length, 1);
        assertEquals(second.requests.length, 0);
    });
});

test("record_plan_deviation cancellation and unsupported capability do not write", async () => {
    await withTempProject(async (projectRoot) => {
        await makePlan(projectRoot);
        const canceled = makeSession(projectRoot, [{ outcome: "canceled" }]);
        const canceledResult = await executeDeviation(
            createPlanDeviationTool({ hostedSession: canceled.session }),
            "call-cancel",
        );
        const unsupported = makeSession(projectRoot, [], false);
        const unsupportedResult = await executeDeviation(
            createPlanDeviationTool({ hostedSession: unsupported.session }),
            "call-unsupported",
        );
        const after = await loadPlan(projectRoot, "demo-plan");
        if (!after) throw new Error("Plan disappeared.");

        assertEquals(canceledResult.details, { decision: "canceled", reason: "deviation_confirmation_canceled" });
        assertEquals(unsupportedResult.details, {
            decision: "unsupported",
            reason: "plan_deviation_confirmation_unavailable",
        });
        assertEquals(unsupportedResult.terminate, true);
        assertEquals(after.attrs.planDeviations, undefined);
    });
});

test("record_plan_deviation writes nothing when Pair execution stops after confirmation", async () => {
    await withTempProject(async (projectRoot) => {
        await makePlan(projectRoot);
        const fixture = makeSession(projectRoot, [{ outcome: "accepted", value: true }]);
        fixture.session.setInteractionAdapter({
            supportsInteraction: (type) => type === "plan_deviation_confirmation",
            requestInteraction: (request) => {
                fixture.requests.push(request);
                const workflow = fixture.session.getActiveExecutionWorkflow();
                if (workflow) fixture.session.setActiveExecutionWorkflow({ ...workflow, pairStopRequested: true });
                return Promise.resolve({ outcome: "accepted", value: true });
            },
        });

        const result = await executeDeviation(createPlanDeviationTool({ hostedSession: fixture.session }), "call-stop");
        const after = await loadPlan(projectRoot, "demo-plan");
        if (!after) throw new Error("Plan disappeared.");

        assertEquals(result.details, { decision: "stale", reason: "execution_context_changed" });
        assertEquals(after.attrs.planDeviations, undefined);
    });
});

test("record_plan_deviation stale revision writes nothing", async () => {
    await withTempProject(async (projectRoot) => {
        await makePlan(projectRoot);
        const fixture = makeSession(projectRoot, [{ outcome: "accepted", value: true }]);
        fixture.session.setInteractionAdapter({
            supportsInteraction: (type) => type === "plan_deviation_confirmation",
            requestInteraction: async (request) => {
                fixture.requests.push(request);
                const current = await loadPlan(projectRoot, "demo-plan");
                if (!current) throw new Error("Plan disappeared.");
                await fsWriteFile(current.path, `${current.markdown}\n<!-- concurrent edit -->\n`);
                return { outcome: "accepted", value: true };
            },
        });

        const result = await executeDeviation(
            createPlanDeviationTool({ hostedSession: fixture.session }),
            "call-stale",
        );
        const after = await loadPlan(projectRoot, "demo-plan");
        if (!after) throw new Error("Plan disappeared.");

        assertEquals(result.details, { decision: "stale", reason: "plan_revision_changed" });
        assertStringIncludes(after.markdown, "<!-- concurrent edit -->");
        assertEquals(after.attrs.planDeviations, undefined);
    });
});

test("record_plan_deviation confirms autonomous execution and survives reload", async () => {
    await withTempProject(async (projectRoot) => {
        await makePlan(projectRoot);
        const fixture = makeSession(projectRoot, [{ outcome: "accepted", value: true }]);
        const workflow = fixture.session.getActiveExecutionWorkflow();
        if (!workflow) throw new Error("Expected execution workflow.");
        fixture.session.setActiveExecutionWorkflow({ ...workflow, collaborationStyle: "autonomous" });
        const result = await executeDeviation(createPlanDeviationTool({ hostedSession: fixture.session }), "auto-call");
        assertEquals(result.details.decision, "recorded");
        assertEquals((await loadPlan(projectRoot, "demo-plan"))?.attrs.planDeviations?.[0].id, "auto-call");
    });
});

test("record_plan_deviation rejects missing active Plan context", async () => {
    await withTempProject(async (projectRoot) => {
        await makePlan(projectRoot);
        const fixture = makeSession(projectRoot, []);
        const workflow = fixture.session.getActiveExecutionWorkflow();
        if (!workflow) throw new Error("Expected execution workflow.");
        fixture.session.setActiveExecutionWorkflow({ ...workflow, planName: "", collaborationStyle: "autonomous" });
        const result = await executeDeviation(createPlanDeviationTool({ hostedSession: fixture.session }), "no-plan");
        assertEquals(result.details, { decision: "inactive", reason: "missing_execution_context" });
        assertEquals(fixture.requests.length, 0);
        assertEquals((await loadPlan(projectRoot, "demo-plan"))?.attrs.planDeviations, undefined);
    });
});

test("record_plan_deviation rejects a changed autonomous execution identity", async () => {
    await withTempProject(async (projectRoot) => {
        await makePlan(projectRoot);
        const fixture = makeSession(projectRoot, []);
        const workflow = fixture.session.getActiveExecutionWorkflow();
        if (!workflow) throw new Error("Expected execution workflow.");
        fixture.session.setActiveExecutionWorkflow({ ...workflow, collaborationStyle: "autonomous" });
        fixture.session.setInteractionAdapter({
            supportsInteraction: () => true,
            requestInteraction: () => {
                fixture.session.setActiveExecutionWorkflow({
                    ...workflow,
                    collaborationStyle: "autonomous",
                    worktreeId: "new-attempt",
                });
                return { outcome: "accepted", value: true };
            },
        });
        const result = await executeDeviation(createPlanDeviationTool({ hostedSession: fixture.session }), "changed");
        assertEquals(result.details, { decision: "stale", reason: "execution_context_changed" });
        assertEquals((await loadPlan(projectRoot, "demo-plan"))?.attrs.planDeviations, undefined);
    });
});

for (const supportsConfirmation of [false, true]) {
    test(`record_plan_deviation unsupported autonomous confirmation does not create Pair state (${supportsConfirmation})`, async () => {
        await withTempProject(async (projectRoot) => {
            await makePlan(projectRoot);
            const fixture = makeSession(projectRoot, [{ outcome: "unsupported" }], supportsConfirmation);
            const workflow = fixture.session.getActiveExecutionWorkflow();
            if (!workflow) throw new Error("Expected execution workflow.");
            fixture.session.setActiveExecutionWorkflow({ ...workflow, collaborationStyle: "autonomous" });
            const result = await executeDeviation(
                createPlanDeviationTool({ hostedSession: fixture.session }),
                "unsupported-auto",
            );
            assertEquals(result.details.decision, "unsupported");
            assertEquals(result.terminate, true);
            assertEquals(fixture.session.getActiveExecutionWorkflow()?.pairPauseReason, undefined);
            assertEquals((await loadPlan(projectRoot, "demo-plan"))?.attrs.planDeviations, undefined);
        });
    });
}

test("record_plan_deviation rejects a Session without active execution", async () => {
    await withTempProject(async (projectRoot) => {
        await makePlan(projectRoot);
        const session = new HostedSession({ id: crypto.randomUUID(), cwd: projectRoot });
        const result = await executeDeviation(createPlanDeviationTool({ hostedSession: session }), "inactive");
        assertEquals(result.details, { decision: "inactive", reason: "plan_execution_inactive" });
        assertEquals((await loadPlan(projectRoot, "demo-plan"))?.attrs.planDeviations, undefined);
        session.dispose();
    });
});
