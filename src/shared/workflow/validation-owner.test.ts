import { assert, assertEquals, assertExists, assertRejects } from "@std/assert";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { loadPlan, savePlan, updatePlanFrontMatter } from "../../plan-store.js";
import { HostedSession } from "../session/hosted-session.js";
import {
    acknowledgeTaskCompletion,
    claimPendingTaskCompletion,
    listPendingTaskCompletions,
    recordAcceptedTaskCompletion,
} from "../session/task-completion-session.ts";
import {
    isValidationCheckpoint,
    makeValidationCheckpoint,
    readValidationReviewState,
    validationCheckpointCanResume,
} from "./validation-checkpoint.ts";
import { recordPlanEvent } from "./plan-lifecycle.js";
import { recordValidationRepairCompletion } from "./validation-supervisor.ts";

type HostedSessionManager = NonNullable<ConstructorParameters<typeof HostedSession>[0]["sessionManager"]>;

function hostedSessionManager(sessionManager: SessionManager): HostedSessionManager {
    return sessionManager as HostedSessionManager;
}

const PRODUCTION_ENTRY_FILES = [
    "../session/agent-handler.ts",
    "../session/runtime/workflows.ts",
    "./orchestrator.ts",
    "./epic-continuation.ts",
    "../../cmd/load-plan/plan-execution.ts",
];

Deno.test("every production entry uses one validation owner", async () => {
    for (const relativePath of PRODUCTION_ENTRY_FILES) {
        const path = new URL(relativePath, import.meta.url);
        const source = await Deno.readTextFile(path);
        assert(
            source.includes("continueWorkflowValidation") || source.includes("runWorkflowValidationToStableBoundary"),
            `${relativePath} does not use the supervisor`,
        );
        assertEquals(source.includes("runValidationLoop"), false, `${relativePath} bypasses the supervisor`);
    }
    const supervisor = await Deno.readTextFile(new URL("./validation-supervisor.ts", import.meta.url));
    assert(supervisor.includes("export async function continueWorkflowValidation"));
    assert(supervisor.includes("export async function runWorkflowValidationToStableBoundary"));
    assert(supervisor.includes("await runValidationLoop"));
    assert(supervisor.includes("continuationPhase: claim.checkpoint.nextPhase"));
    assert(supervisor.includes("prior.lastSettledOperationId === args.taskCompletionId"));
    const handler = await Deno.readTextFile(new URL("../session/agent-handler.ts", import.meta.url));
    assert(handler.includes("taskCompletionId: acceptedCompletion.completionId"));
});

Deno.test("validation checkpoint survives a new Plan load", async () => {
    const root = await Deno.makeTempDir({ prefix: "runwield-validation-checkpoint-" });
    try {
        await savePlan(root, "demo", "# Demo\n", {
            planId: "plan-demo",
            classification: "PLANNED_CHANGE",
            status: "implemented",
            worktreeId: "wt-demo",
        });
        const plan = await loadPlan(root, "demo");
        assertExists(plan);
        const checkpoint = makeValidationCheckpoint({
            attemptId: "wt-demo",
            generation: "generation-one",
            status: "implemented",
            phase: "mechanical",
            state: "awaiting_repair",
            repairKind: "ci",
            repairGeneration: "repair-one",
        });
        await updatePlanFrontMatter(root, "demo", { validationCheckpoint: checkpoint }, plan.attrs, {
            expectedRevision: plan.revision,
        });

        const reopened = await loadPlan(root, "demo");
        assertExists(reopened);
        const value = reopened.attrs.validationCheckpoint;
        assert(value && typeof value === "object" && !Array.isArray(value));
        assert(isValidationCheckpoint(value));
        assertEquals(value.generation, "generation-one");
        assertEquals(value.repairGeneration, "repair-one");
    } finally {
        await Deno.remove(root, { recursive: true }).catch(() => {});
    }
});

Deno.test("an earlier validation checkpoint remains authoritative only for the same attempt", () => {
    const checkpoint = makeValidationCheckpoint({
        attemptId: "wt-demo",
        generation: "generation-one",
        status: "implemented",
        phase: "mechanical",
        state: "paused",
    });

    assertEquals(validationCheckpointCanResume(checkpoint, "wt-demo", "implemented"), true);
    assertEquals(validationCheckpointCanResume(checkpoint, "wt-demo", "validated_ci"), true);
    assertEquals(validationCheckpointCanResume(checkpoint, "wt-demo", "reviewed"), true);
    assertEquals(validationCheckpointCanResume(checkpoint, "another-attempt", "validated_ci"), false);

    const futureCheckpoint = makeValidationCheckpoint({
        attemptId: "wt-demo",
        generation: "generation-two",
        status: "reviewed",
        phase: "delivery",
        state: "paused",
    });
    assertEquals(validationCheckpointCanResume(futureCheckpoint, "wt-demo", "validated_ci"), false);
});

Deno.test("semantic feedback commits open Review Issues with the lifecycle transition", async () => {
    const root = await Deno.makeTempDir({ prefix: "runwield-validation-review-authority-" });
    try {
        await savePlan(root, "demo", "# Demo\n", {
            planId: "plan-demo",
            classification: "PLANNED_CHANGE",
            status: "validated_ci",
            worktreeId: "wt-demo",
        });
        const plan = await loadPlan(root, "demo");
        assertExists(plan);
        const checkpoint = makeValidationCheckpoint({
            attemptId: "wt-demo",
            generation: "validation-one",
            status: "implemented",
            phase: "mechanical",
            state: "awaiting_repair",
            repairKind: "semantic",
            repairGeneration: "repair-one",
            reviewState: {
                semanticRound: 1,
                reviewLedger: {
                    sequence: 1,
                    items: [{
                        id: "R1-1",
                        openedInRound: 1,
                        resolvedInRound: null,
                        title: "Keep the saved candidate",
                        requirement: "Non-success outcomes preserve work.",
                        evidence: "The cleanup path removed it.",
                    }],
                },
                repairBaselineTree: "tree-before-repair",
            },
        });
        await recordPlanEvent({
            cwd: root,
            planName: "demo",
            event: "semantic_review_feedback",
            currentStatus: "implemented",
            details: {
                triageMeta: plan.attrs,
                failureReason: "One issue remains.",
                validationCheckpoint: checkpoint,
            },
        });

        const reopened = await loadPlan(root, "demo");
        assertExists(reopened);
        assertEquals(reopened.attrs.status, "implemented");
        assertEquals(reopened.attrs.validationCheckpoint?.state, "awaiting_repair");
        assertEquals(readValidationReviewState(reopened.attrs.validationCheckpoint)?.reviewLedger.items[0].id, "R1-1");
    } finally {
        await Deno.remove(root, { recursive: true }).catch(() => {});
    }
});

Deno.test("semantic repair completion is an idempotent mechanical receipt", async () => {
    const root = await Deno.makeTempDir({ prefix: "runwield-validation-repair-receipt-" });
    try {
        await savePlan(root, "demo", "# Demo\n", {
            planId: "plan-demo",
            classification: "PLANNED_CHANGE",
            status: "implemented",
            worktreeId: "wt-demo",
        });
        const plan = await loadPlan(root, "demo");
        assertExists(plan);
        const checkpoint = makeValidationCheckpoint({
            attemptId: "wt-demo",
            generation: "validation-one",
            status: "implemented",
            phase: "mechanical",
            state: "awaiting_repair",
            repairKind: "semantic",
            repairGeneration: "repair-one",
            reviewState: {
                semanticRound: 1,
                reviewLedger: {
                    sequence: 1,
                    items: [{
                        id: "R1-1",
                        openedInRound: 1,
                        resolvedInRound: null,
                        status: "new",
                        title: "Missing guard",
                        requirement: "Step 1",
                        evidence: "a.ts",
                    }],
                },
                repairBaselineTree: "tree-before-repair",
            },
        });
        await updatePlanFrontMatter(root, "demo", { validationCheckpoint: checkpoint }, plan.attrs, {
            expectedRevision: plan.revision,
        });

        await recordValidationRepairCompletion({
            projectRoot: root,
            planName: "demo",
            repairGeneration: "repair-one",
            report: "Fixed R1-1.",
        });
        await recordValidationRepairCompletion({
            projectRoot: root,
            planName: "demo",
            repairGeneration: "repair-one",
            report: "This duplicate must not replace the first receipt.",
        });

        const reopened = await loadPlan(root, "demo");
        assertExists(reopened);
        assertEquals(reopened.attrs.validationCheckpoint?.state, "ready");
        assertEquals(reopened.attrs.validationCheckpoint?.repairCompletedOperationId, "repair-one");
        assertEquals(reopened.attrs.validationCheckpoint?.lastSettledOperationId, undefined);
        assertEquals(readValidationReviewState(reopened.attrs.validationCheckpoint)?.lastRepairReport, "Fixed R1-1.");
        assertEquals(
            readValidationReviewState(reopened.attrs.validationCheckpoint)?.reviewLedger.items[0].status,
            "fix_claimed",
        );
        await assertRejects(
            () =>
                recordValidationRepairCompletion({
                    projectRoot: root,
                    planName: "demo",
                    repairGeneration: "different-repair",
                    report: "Wrong repair.",
                }),
            Error,
            "does not match",
        );
    } finally {
        await Deno.remove(root, { recursive: true }).catch(() => {});
    }
});

Deno.test("repair completion survives process loss and resumes once", () => {
    const root = Deno.makeTempDirSync({ prefix: "runwield-validation-owner-" });
    try {
        const manager = SessionManager.inMemory(root);
        const first = new HostedSession({ id: "first", cwd: root, sessionManager: hostedSessionManager(manager) });
        const rootAgent = { dispose: () => {} };
        first.setRootAgentSession(rootAgent);
        first.setActiveExecutionWorkflow({
            planName: "demo",
            triageMeta: { classification: "PLANNED_CHANGE" },
            executionAgent: "engineer",
            executionStarted: true,
            executionMode: "non_git_in_place",
            nonGitInPlace: true,
            validationContinuation: true,
            validationGeneration: "generation-one",
        });
        const completionId = recordAcceptedTaskCompletion({
            hostedSession: first,
            toolCallId: "repair-done",
            agentName: "engineer",
            report: "- Fixed the failed check.",
            timestampMs: 10,
        });
        assertExists(completionId);

        // A new HostedSession reads the durable root journal. It claims the same
        // generation once, then writes one consumed event.
        const resumed = new HostedSession({ id: "resumed", cwd: root, sessionManager: hostedSessionManager(manager) });
        resumed.setRootAgentSession(rootAgent);
        resumed.setActiveExecutionWorkflow({
            planName: "demo",
            triageMeta: { classification: "PLANNED_CHANGE" },
            executionAgent: "engineer",
            executionStarted: true,
            executionMode: "non_git_in_place",
            nonGitInPlace: true,
            validationContinuation: true,
            validationGeneration: "generation-one",
        });
        const claim = claimPendingTaskCompletion(resumed, rootAgent);
        assertExists(claim);
        assertEquals(claim.validationGeneration, "generation-one");
        acknowledgeTaskCompletion(resumed, claim);
        assertEquals(listPendingTaskCompletions(resumed), []);
        assertEquals(claimPendingTaskCompletion(resumed, rootAgent), null);
    } finally {
        Deno.removeSync(root, { recursive: true });
    }
});
