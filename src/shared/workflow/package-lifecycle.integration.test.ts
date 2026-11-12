import { seedPlanController, inspectPlanFixtureController } from "../testing/plan-state-fixture.ts";
import { selectPlanAccess } from "../../plan-store/index.ts";
import { resolvePlanWithPrimaryRecovery } from "../../plan-store/index.ts";
import { loadPlanActionEvidence } from "./plan-actions.ts";
import { loadPlanBodyById, savePlanBodyById } from "../../plan-store/index.ts";
import {
    updatePlanPackageMetadata,
    readPlanPackageInput,
    readPlanPackage,
    renamePlanPackage,
} from "../../plan-store/packages.ts";
import { findPlansByParent } from "../../plan-store/index.ts";
import { appendEpicManualQaSection } from "../../plan-store/index.ts";
import { prepareSequenceReview, applySequenceReviewDecision } from "../../plan-store/index.ts";
import { applySharedPlanReviewDecision } from "../../plan-store/index.ts";
import { PLAN_APPROVAL_ACTIONS } from "./plan-approval.ts";
import { test } from "node:test";
import { equal, deepEqual, ok, rejects } from "node:assert/strict";
import fs from "node:fs/promises";
import { join } from "node:path";
import { create, read, packageFixture } from "../testing/plan-package-fixture.ts";
import { preparePlanWorkflow } from "../../plan-store/index.ts";
import { loadPackageWorkflowPlan, capturePackageWorkflowInput } from "../../plan-store/workflows.ts";
import { withPackageWorkflow } from "../../plan-store/workflows.ts";
import { recordPlanEvent } from "./plan-lifecycle.js";
import { startActiveExecutionWorkflow, createExecutionStartPorts } from "./execution-start.ts";
import { git } from "../git-test-fixture.ts";

test("explicit package admission reads home bytes despite a poisoned repository Plan", async () => {
    const f = await packageFixture();
    try {
        const p = await create(f.identity);
        await fs.mkdir(join(f.root, "docs/plans"), { recursive: true });
        await fs.writeFile(
            join(f.root, "docs/plans/one.md"),
            "---\nplanId: counterfeit\nstatus: verified\n---\nWrong source\n",
        );
        const selection = { identity: f.identity, planId: p.metadata.planId, expectedRevision: p.metadata.revision };
        const result = await preparePlanWorkflow(f.root, "one", selection);
        equal(result.plan?.path, join(p.path, "context.md"));
        equal(result.plan?.attrs.planId, p.metadata.planId);
        equal(result.plan?.attrs.status, "draft");
        equal(result.plan?.markdown, await fs.readFile(join(p.path, "context.md"), "utf8"));
    } finally {
        await f.cleanup();
    }
});

test("existing lifecycle events persist package metadata without rewriting Markdown", async () => {
    const f = await packageFixture();
    try {
        const p = await create(f.identity);
        const before = await fs.readFile(join(p.path, "context.md"), "utf8");
        await withPackageWorkflow(
            f.root,
            { identity: f.identity, planId: p.metadata.planId, expectedRevision: 1 },
            async () => {
                await recordPlanEvent({
                    cwd: f.root,
                    planName: "one",
                    event: "review_approved",
                    currentStatus: "draft",
                });
                equal((await loadPackageWorkflowPlan("one")).attrs.status, "approved");
            },
        );
        equal((await read(f.identity)).metadata.definition.status, "approved");
        equal(await fs.readFile(join(p.path, "context.md"), "utf8"), before);
        await rejects(fs.access(join(f.root, "docs/plans/one.md")));
    } finally {
        await f.cleanup();
    }
});

test("controller scalar and complex evidence survive a fresh package scope", async () => {
    const f = await packageFixture();
    try {
        const p = await create(f.identity);
        await withPackageWorkflow(
            f.root,
            { identity: f.identity, planId: p.metadata.planId, expectedRevision: 1 },
            async () => {
                await seedPlanController(
                    f.root,
                    { planName: "one", planId: p.metadata.planId },
                    {
                        implementedAt: "2026-11-05T00:00:00Z",
                        validationCheckpoint: null,
                    },
                );
            },
        );
        const current = await read(f.identity);
        ok(current.metadata.workflow?.controller);
        await withPackageWorkflow(
            f.root,
            { identity: f.identity, planId: p.metadata.planId, expectedRevision: current.metadata.revision },
            async () => {
                const state = await inspectPlanFixtureController(f.root, {
                    planName: "one",
                    planId: p.metadata.planId,
                });
                equal(state?.state.implementedAt, "2026-11-05T00:00:00Z");
                equal(state?.state.validationCheckpoint, null);
            },
        );
        deepEqual(
            current.documents.map((doc) => doc.hash),
            p.documents.map((doc) => doc.hash),
        );
    } finally {
        await f.cleanup();
    }
});

test("a stale explicit package selection cannot fall back to checkout authority", async () => {
    const f = await packageFixture();
    try {
        await create(f.identity);
        await rejects(
            preparePlanWorkflow(f.root, "one", { identity: f.identity, planId: "plan-one", expectedRevision: 9 }),
            /changed/,
        );
        await rejects(
            preparePlanWorkflow(f.root, "one", { identity: f.identity, planId: "missing", expectedRevision: 1 }),
            /missing/,
        );
    } finally {
        await f.cleanup();
    }
});

for (const changed of ["validation.md", "manual-qa.md", "parent"] as const) {
    test(`review rejects changed required ${changed} input without advancing status`, async () => {
        const f = await packageFixture();
        try {
            const parent = await create(f.identity, {
                name: "parent",
                planId: "parent",
                definition: { classification: "PROJECT", status: "draft", type: "epic" },
            });
            const p = await create(f.identity, { parentPlanId: "parent" });
            await withPackageWorkflow(
                f.root,
                { identity: f.identity, planId: p.metadata.planId, expectedRevision: 1 },
                async () => {
                    const view = await loadPackageWorkflowPlan("one");
                    const input = await capturePackageWorkflowInput("one");
                    await fs.writeFile(
                        changed === "parent" ? join(parent.path, "context.md") : join(p.path, changed),
                        "Changed requirements\n",
                    );
                    const result = await applySharedPlanReviewDecision({
                        cwd: f.root,
                        planName: "one",
                        planPath: view.path,
                        planWithFrontMatter: view.markdown,
                        planRevision: view.revision,
                        originalAttrs: view.attrs,
                        trustedClassification: "PLANNED_CHANGE",
                        packageInput: input,
                        decision: { approved: true, approvalAction: PLAN_APPROVAL_ACTIONS.LATER },
                    });
                    equal(result.cancellationReason, "stale_plan_review");
                    equal((await loadPackageWorkflowPlan("one")).attrs.status, "draft");
                },
            );
        } finally {
            await f.cleanup();
        }
    });
}

test("shared review and readiness retain complete input and ignore controller-only timestamp changes", async () => {
    const f = await packageFixture();
    try {
        const p = await create(f.identity);
        await withPackageWorkflow(
            f.root,
            { identity: f.identity, planId: p.metadata.planId, expectedRevision: 1 },
            async () => {
                const view = await loadPackageWorkflowPlan("one");
                const input = await capturePackageWorkflowInput("one");
                await seedPlanController(f.root, { planName: "one" }, { updatedAt: "2026-11-05T12:00:00Z" });
                const result = await applySharedPlanReviewDecision({
                    cwd: f.root,
                    planName: "one",
                    planPath: view.path,
                    planWithFrontMatter: view.markdown,
                    planRevision: view.revision,
                    originalAttrs: view.attrs,
                    trustedClassification: "PLANNED_CHANGE",
                    packageInput: input,
                    decision: {
                        approved: true,
                        approvalAction: PLAN_APPROVAL_ACTIONS.RUN,
                        executionAgent: "engineer",
                        collaborationRecommendation: "autonomous",
                    },
                });
                equal(result.approved, true, result.feedback || "Package review must approve current input");
                await recordPlanEvent({
                    cwd: f.root,
                    planName: "one",
                    event: "readiness_passed",
                    currentStatus: "approved",
                });
                equal((await loadPackageWorkflowPlan("one")).attrs.status, "ready_for_work");
            },
        );
        const current = await read(f.identity);
        ok(current.metadata.workflow?.review);
        ok(current.metadata.workflow?.readiness);
        deepEqual(
            current.documents.map((doc) => doc.hash),
            p.documents.map((doc) => doc.hash),
        );
    } finally {
        await f.cleanup();
    }
});

test("Sequence review follows package IDs and approves the complete ordered family", async () => {
    const f = await packageFixture();
    try {
        const parent = await create(f.identity, {
            planId: "sequence",
            name: "sequence",
            definition: { classification: "PROJECT", type: "sequence", status: "draft" },
        });
        await create(f.identity, {
            planId: "child-a",
            name: "unrelated-directory/first",
            parentPlanId: "sequence",
            definition: {
                classification: "PLANNED_CHANGE",
                status: "draft",
                order: 1,
                executionAgent: "engineer",
                collaborationRecommendation: "autonomous",
            },
        });
        await create(f.identity, {
            planId: "child-b",
            name: "another-name",
            parentPlanId: "sequence",
            definition: {
                classification: "PLANNED_CHANGE",
                status: "draft",
                order: 2,
                executionAgent: "engineer",
                collaborationRecommendation: "autonomous",
            },
        });
        await withPackageWorkflow(
            f.root,
            { identity: f.identity, planId: parent.metadata.planId, expectedRevision: 1 },
            async () => {
                const documents = await prepareSequenceReview(f.root, "sequence");
                deepEqual(
                    documents.map((doc) => doc.planId),
                    ["sequence", "child-a", "child-b"],
                );
                const result = await applySequenceReviewDecision({
                    cwd: f.root,
                    documents,
                    decision: {
                        approved: true,
                        approvalAction: "later",
                        documents: documents.map((doc) => ({ planId: doc.planId, plan: doc.plan })),
                    },
                });
                equal(result.approved, true, result.feedback || "Sequence approval");
                equal((await loadPackageWorkflowPlan("another-name")).attrs.status, "ready_for_work");
            },
        );
    } finally {
        await f.cleanup();
    }
});

for (const change of ["remove", "policy"] as const) {
    test(`readiness rejects ${change} after review without advancing status`, async () => {
        const f = await packageFixture();
        try {
            const p = await create(f.identity);
            await withPackageWorkflow(
                f.root,
                { identity: f.identity, planId: p.metadata.planId, expectedRevision: 1 },
                async () => {
                    await recordPlanEvent({
                        cwd: f.root,
                        planName: "one",
                        event: "review_approved",
                        currentStatus: "draft",
                    });
                    const current = await read(f.identity);
                    if (change === "remove") await fs.rm(join(p.path, "validation.md"));
                    else
                        await updatePlanPackageMetadata(f.identity, p.metadata.planId, current.metadata.revision, {
                            definition: { ...current.metadata.definition, executionAgent: "frontend-engineer" },
                        });
                    await rejects(
                        recordPlanEvent({
                            cwd: f.root,
                            planName: "one",
                            event: "readiness_passed",
                            currentStatus: "approved",
                        }),
                    );
                    equal(
                        JSON.parse(await fs.readFile(join(p.path, "plan.wld.json"), "utf8")).definition.status,
                        "approved",
                    );
                },
            );
        } finally {
            await f.cleanup();
        }
    });
}

test("formatting-only review captures new exact bytes while reply-only review preserves status", async () => {
    const f = await packageFixture();
    try {
        const p = await create(f.identity, {
            documents: {
                "context.md": "# Plan\n\nA sentence with words.\n",
                "validation.md": "# Verify\n\nRun checks.\n",
            },
        });
        await withPackageWorkflow(
            f.root,
            { identity: f.identity, planId: p.metadata.planId, expectedRevision: 1 },
            async () => {
                const view = await loadPackageWorkflowPlan("one");
                const input = await capturePackageWorkflowInput("one");
                const options = {
                    cwd: f.root,
                    planName: "one",
                    planPath: view.path,
                    planWithFrontMatter: view.markdown,
                    planRevision: view.revision,
                    originalAttrs: view.attrs,
                    trustedClassification: "PLANNED_CHANGE" as const,
                    packageInput: input,
                };
                const reply = await applySharedPlanReviewDecision({
                    ...options,
                    decision: { conversationTurn: true, feedback: "Explain the approach" },
                });
                equal(reply.conversationTurn, true);
                equal((await read(f.identity)).metadata.definition.status, "draft");
                const formatted = "# Plan\n\nA sentence\nwith words.\n";
                await fs.writeFile(join(p.path, "context.md"), formatted);
                const result = await applySharedPlanReviewDecision({
                    ...options,
                    decision: { approved: true, approvalAction: PLAN_APPROVAL_ACTIONS.LATER },
                });
                equal(result.approved, true, result.feedback || "Expected review approval");
                const current = await read(f.identity);
                const retained = await readPlanPackageInput(f.identity, current.metadata.workflow!.review!.inputs[0]);
                equal(
                    new TextDecoder().decode(retained.documents.find((doc) => doc.name === "context.md")!.bytes),
                    formatted,
                );
            },
        );
    } finally {
        await f.cleanup();
    }
});

test("live ID relationships survive rename and unrelated sibling edits without staling the child", async () => {
    const f = await packageFixture();
    let executionCwd: string | undefined;
    try {
        const parent = await create(f.identity, {
            planId: "parent",
            name: "arbitrary/parent",
            definition: { classification: "PROJECT", type: "epic", status: "draft" },
        });
        const p = await create(f.identity, {
            parentPlanId: "parent",
            definition: { classification: "PLANNED_CHANGE", status: "draft", order: 1 },
        });
        const sibling = await create(f.identity, {
            planId: "sibling",
            name: "sibling",
            parentPlanId: "parent",
            definition: { classification: "PLANNED_CHANGE", status: "draft", order: 2 },
        });
        await withPackageWorkflow(
            f.root,
            { identity: f.identity, planId: p.metadata.planId, expectedRevision: 1 },
            async () => {
                await recordPlanEvent({
                    cwd: f.root,
                    planName: "one",
                    event: "review_approved",
                    currentStatus: "draft",
                });
                await fs.writeFile(join(sibling.path, "context.md"), "# Immediate sibling edit\n");
                await renamePlanPackage(f.identity, parent.metadata.planId, 1, "renamed-parent");
                equal((await loadPackageWorkflowPlan("one")).attrs.parentPlan, "renamed-parent");
                deepEqual(
                    (await findPlansByParent(f.root, "renamed-parent")).map((p) => p.attrs.planId),
                    ["plan-one", "sibling"],
                );
                equal((await loadPackageWorkflowPlan("sibling")).body, "# Immediate sibling edit\n");
                await recordPlanEvent({
                    cwd: f.root,
                    planName: "one",
                    event: "readiness_passed",
                    currentStatus: "approved",
                });
                equal((await loadPackageWorkflowPlan("one")).attrs.status, "ready_for_work");
                const ready = await loadPackageWorkflowPlan("one");
                const execution = await startActiveExecutionWorkflow({
                    cwd: f.root,
                    planName: "one",
                    triageMeta: ready.attrs,
                    currentStatus: "ready_for_work",
                    ports: createExecutionStartPorts(),
                });
                executionCwd = execution.executionCwd;
                equal((await loadPackageWorkflowPlan("one")).attrs.targetBranch, "main");
                await appendEpicManualQaSection({
                    projectRoot: f.root,
                    epicPlanName: "renamed-parent",
                    childPlanName: "one",
                    childHeading: "Check",
                    checklistMarkdown: "Manual verification steps for one\n- [ ] Check behavior",
                });
                ok(
                    (await fs.readFile(join((await read(f.identity, "parent")).path, "manual-qa.md"), "utf8")).includes(
                        'child="plan-one"',
                    ),
                );
                await rejects(fs.access(join(f.root, "docs/plans")));
            },
        );
    } finally {
        if (executionCwd && executionCwd !== f.root) await git(f.root, ["worktree", "remove", "--force", executionCwd]);
        await f.cleanup();
    }
});

test("internal load/actions and ordinary body save keep selected package authority and raw prose", async () => {
    const f = await packageFixture();
    try {
        const p = await create(f.identity);
        await create(f.identity, { planId: "second", name: "second" });
        const selection = { identity: f.identity, planId: p.metadata.planId, expectedRevision: 1 };
        await rejects(preparePlanWorkflow(f.root, "second", selection), /does not match/);
        equal(
            (await resolvePlanWithPrimaryRecovery(f.root, "one", await selectPlanAccess(f.root, "one"))).plan.path,
            join(p.path, "context.md"),
        );
        await withPackageWorkflow(f.root, selection, async () => {
            equal((await loadPlanActionEvidence(f.root, p.metadata.planId)).kind, "success");
            const body = await loadPlanBodyById(f.root, p.metadata.planId);
            const prose = "---\nstatus: verified\nplanId: forged\n---\n# Plain user text\n";
            await savePlanBodyById(f.root, p.metadata.planId, prose, body.bodyHash, {
                expectedRevision: body.revision,
            });
            equal((await loadPlanBodyById(f.root, p.metadata.planId)).body, prose);
            equal((await loadPackageWorkflowPlan("one")).attrs.status, "draft");
            equal((await read(f.identity)).metadata.revision, 1);
        });
    } finally {
        await f.cleanup();
    }
});

test("strict package workflow references reject unsupported fields and another Plan's input", async () => {
    const f = await packageFixture();
    try {
        const p = await create(f.identity);
        const path = join(p.path, "plan.wld.json");
        for (const workflow of [
            { controller: { revisionId: crypto.randomUUID(), planId: "foreign" } },
            {
                review: {
                    inputs: [{ projectId: f.identity.projectId, planId: "foreign", inputId: crypto.randomUUID() }],
                    definitionHash: "a".repeat(64),
                },
            },
            { unsupported: true },
            {
                attempt: {
                    personalOwner: "x",
                    repositoryId: "x",
                    repositoryRoot: "relative",
                    attemptId: "x",
                    input: {},
                },
            },
        ]) {
            await fs.writeFile(path, JSON.stringify({ ...p.metadata, workflow }));
            const inspected = await readPlanPackage(f.identity, { planId: p.metadata.planId });
            ok(inspected.kind !== "loaded");
        }
        await fs.writeFile(path, JSON.stringify(p.metadata));
        equal((await read(f.identity)).metadata.revision, 1);
    } finally {
        await f.cleanup();
    }
});

test("two controller writers using the same package revision cannot both commit", async () => {
    const f = await packageFixture();
    try {
        const p = await create(f.identity);
        await withPackageWorkflow(
            f.root,
            { identity: f.identity, planId: p.metadata.planId, expectedRevision: 1 },
            async () => {
                const identity = { planName: "one", planId: p.metadata.planId };
                const results = await Promise.allSettled([
                    seedPlanController(f.root, identity, { failureReason: "first" }, { expectedRevision: 1 }),
                    seedPlanController(f.root, identity, { failureReason: "second" }, { expectedRevision: 1 }),
                ]);
                equal(results.filter((result) => result.status === "fulfilled").length, 1);
                const winner = results.find((result) => result.status === "fulfilled")!;
                ok(winner.status === "fulfilled");
                equal(
                    (await inspectPlanFixtureController(f.root, identity))?.state.failureReason,
                    winner.value.state.failureReason,
                );
                equal((await read(f.identity)).metadata.revision, 2);
            },
        );
    } finally {
        await f.cleanup();
    }
});

for (const resource of ["context.md", "validation.md"] as const) {
    test(`Sequence preserves formatting-only ${resource} bytes in its approved input`, async () => {
        const f = await packageFixture();
        try {
            const parent = await create(f.identity, {
                planId: "sequence",
                name: "sequence",
                definition: { classification: "PROJECT", type: "sequence", status: "draft" },
            });
            const child = await create(f.identity, {
                planId: "child",
                name: "child",
                parentPlanId: "sequence",
                documents: {
                    "context.md": "# Plan\n\nA sentence with words.\n",
                    "validation.md": "# Plan\n\nA sentence with words.\n",
                },
                definition: {
                    classification: "PLANNED_CHANGE",
                    status: "draft",
                    order: 1,
                    executionAgent: "engineer",
                    collaborationRecommendation: "autonomous",
                },
            });
            await withPackageWorkflow(
                f.root,
                { identity: f.identity, planId: parent.metadata.planId, expectedRevision: 1 },
                async () => {
                    const documents = await prepareSequenceReview(f.root, "sequence");
                    const formatted = "# Plan\n\nA sentence\nwith words.\n";
                    await fs.writeFile(join(child.path, resource), formatted);
                    const result = await applySequenceReviewDecision({
                        cwd: f.root,
                        documents,
                        decision: {
                            approved: true,
                            approvalAction: "later",
                            documents: documents.map((doc) => ({ planId: doc.planId, plan: doc.plan })),
                        },
                    });
                    equal(result.approved, true, result.feedback || "Expected Sequence approval");
                    const current = await read(f.identity, "child");
                    const input = current.metadata.workflow!.readiness!;
                    const retained = await readPlanPackageInput(
                        f.identity,
                        input.inputs.find((ref) => ref.planId === "child")!,
                    );
                    equal(
                        new TextDecoder().decode(retained.documents.find((doc) => doc.name === resource)!.bytes),
                        formatted,
                    );
                    equal(await fs.readFile(join(child.path, resource), "utf8"), formatted);
                },
            );
        } finally {
            await f.cleanup();
        }
    });
}
