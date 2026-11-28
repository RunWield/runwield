import { deepEqual, equal, ok } from "node:assert/strict";
import { test } from "node:test";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { platform } from "node:process";
import { getHomeDir } from "../constants.ts";
import { readLiveSessionConnection } from "../shared/session/live-session-connection.ts";
import { applySequencePlanReviewForWorkflow } from "./project-lifecycle.ts";
import { create, packageFixture } from "../shared/testing/plan-package-fixture.ts";
import { seedPlanController } from "../shared/testing/plan-state-fixture.ts";
import {
    openProjectPlanLifecycle,
    openProjectPlanStore,
    planDocumentsForCheckout,
    preparePlanReviewVersion,
    prepareSequenceReviewPresentation,
    prepareSequenceReviewVersion,
    withLocalPlanWorkflow,
} from "./index.ts";
import {
    restoreLegacyPlanReviewVersion,
    restorePlanReviewVersion,
    serializePlanReviewVersion,
} from "./lifecycle-review.ts";

test("a transported review decision uses the sender's source and admitted Project and Session", async () => {
    const fixture = await packageFixture();
    const other = await packageFixture();
    try {
        const lifecycle = openProjectPlanLifecycle(fixture.identity.projectId, { admitted: fixture.identity });
        const store = openProjectPlanStore(fixture.identity.projectId, { admitted: fixture.identity });
        const plan = await store.create({
            planName: "review",
            contextMarkdown: "Original prose.\n",
            definition: { classification: "PLANNED_CHANGE" },
        });
        await create(other.identity, {
            name: plan.name,
            planId: plan.planId,
            documents: { "context.md": plan.body, "validation.md": "" },
            definition: { classification: "PLANNED_CHANGE", status: "draft" },
        });
        const document = await planDocumentsForCheckout(fixture.root).load(plan.name);
        ok(document);
        const { displayedVersion } = await preparePlanReviewVersion(fixture.root, plan.name, document.path, {
            runwieldSessionId: "original-session",
        });
        const retained = serializePlanReviewVersion(displayedVersion);
        ok(retained);
        const transported = JSON.parse(JSON.stringify(retained));
        equal(restorePlanReviewVersion(transported, "different-session"), undefined);
        equal(
            restorePlanReviewVersion(
                { ...retained, planId: "different-plan" as typeof plan.planId },
                "original-session",
            ),
            undefined,
        );
        const restored = restorePlanReviewVersion(transported, "original-session");
        ok(restored);
        deepEqual(Object.keys(restored), ["planId", "revision"]);
        equal(retained.source.kind, "individual");
        const reviewed = retained.source.review;
        const legacyMetadata = {
            cwd: fixture.root,
            planId: plan.planId,
            expectedStatus: reviewed.reviewEvidence?.status,
            expectedWorktree: reviewed.reviewEvidence?.worktree,
            expectedRevision: reviewed.planRevision,
            packageInput: reviewed.packageInput,
            reviewedSource: {
                planName: reviewed.planName,
                path: reviewed.planPath,
                markdown: reviewed.planWithFrontMatter,
                revision: reviewed.planRevision,
                attrs: reviewed.originalAttrs,
            },
        };
        equal(
            restoreLegacyPlanReviewVersion({ ...legacyMetadata, packageInput: undefined }, "original-session")
                .displayedVersion,
            undefined,
        );
        equal(
            restoreLegacyPlanReviewVersion(
                { ...legacyMetadata, expectedRevision: "different-source" },
                "original-session",
            ).displayedVersion,
            undefined,
        );
        const legacy = restoreLegacyPlanReviewVersion(legacyMetadata, "original-session").displayedVersion;
        ok(legacy);
        const decision = {
            event: "review_approved" as const,
            displayedVersion: restored,
            approvalAction: "later" as const,
        };
        const foreign = openProjectPlanLifecycle(other.identity.projectId, { admitted: other.identity });
        equal((await foreign.applyEvent(plan.planId, decision)).cancellationReason, "stale_plan_review");
        const foreignStore = openProjectPlanStore(other.identity.projectId, { admitted: other.identity });
        equal((await foreignStore.read(plan.planId)).attrs.status, "draft");
        await withLocalPlanWorkflow(fixture.root, plan.name, () =>
            seedPlanController(fixture.root, { planName: plan.name }, { failureReason: "New Core evidence." }),
        );
        const controllerUpdated = await store.read(plan.planId);
        ok(controllerUpdated.revision !== plan.revision);
        equal(controllerUpdated.body, plan.body);
        equal(controllerUpdated.attrs.status, plan.attrs.status);
        equal(
            (await lifecycle.applyEvent(plan.planId, { ...decision, displayedVersion: legacy })).cancellationReason,
            "stale_plan_review",
        );
        deepEqual(await store.read(plan.planId), controllerUpdated);
        const edited = await store.editBody(plan.planId, {
            body: "Newer text.\n",
            expectedRevision: controllerUpdated.revision,
        });
        equal((await lifecycle.applyEvent(plan.planId, decision)).cancellationReason, "stale_plan_review");
        equal(
            (await lifecycle.applyEvent(plan.planId, { ...decision, displayedVersion: legacy })).cancellationReason,
            "stale_plan_review",
        );
        deepEqual(await store.read(plan.planId), edited);
    } finally {
        await Promise.all([fixture.cleanup(), other.cleanup()]);
    }
});

test("independent Sequence reviews with the same parent revision retain different child content", async () => {
    const fixture = await packageFixture();
    try {
        const lifecycle = openProjectPlanLifecycle(fixture.identity.projectId, { admitted: fixture.identity });
        const store = openProjectPlanStore(fixture.identity.projectId, { admitted: fixture.identity });
        const parent = await store.create({
            planName: "sequence",
            contextMarkdown: "# Sequence\n",
            definition: { classification: "PROJECT", type: "sequence" },
        });
        const child = await store.create({
            planName: "sequence/child",
            contextMarkdown: "# Child\n",
            parentPlan: parent.name,
            definition: { classification: "PLANNED_CHANGE", order: 1 },
        });
        const before = await prepareSequenceReviewPresentation(fixture.root, parent.name);
        const beforeVersion = await prepareSequenceReviewVersion(fixture.root, parent.name, before);
        await store.editBody(child.planId, { body: "# Revised Child\n", expectedRevision: child.revision });
        const after = await prepareSequenceReviewPresentation(fixture.root, parent.name);
        const afterVersion = await prepareSequenceReviewVersion(fixture.root, parent.name, after);
        equal(afterVersion.revision, beforeVersion.revision);
        const decision = { event: "review_approved" as const, approvalAction: "later" as const };
        const stale = await lifecycle.applyEvent(parent.planId, {
            ...decision,
            displayedVersion: beforeVersion,
            documents: before.map(({ plan, planId }) => ({ plan, planId })),
        });
        equal(stale.cancellationReason, "stale_plan_review");
        equal((await store.read(parent.planId)).attrs.status, "draft");
        equal((await store.read(child.planId)).attrs.status, "draft");
        const approved = await lifecycle.applyEvent(parent.planId, {
            ...decision,
            displayedVersion: afterVersion,
            documents: after.map(({ plan, planId }) => ({ plan, planId })),
        });
        equal(approved.approved, true, approved.feedback || "Sequence review was not applied");
        equal((await store.read(child.planId)).body, "# Revised Child\n");
        equal((await store.read(parent.planId)).attrs.status, "ready_for_work");
    } finally {
        await fixture.cleanup();
    }
});

for (const wire of ["current", "legacy"] as const) {
    test(`${wire} private review transport accepts the original source and recovers a lost reply`, async () => {
        const fixture = await packageFixture();
        try {
            const lifecycle = openProjectPlanLifecycle(fixture.identity.projectId, { admitted: fixture.identity });
            const store = openProjectPlanStore(fixture.identity.projectId, { admitted: fixture.identity });
            const plan = await store.create({
                planName: "transport-review",
                contextMarkdown: "# Prepared review\n\nOriginal immutable prose.\n",
                definition: { classification: "PLANNED_CHANGE" },
            });
            const document = await planDocumentsForCheckout(fixture.root).load(plan.name);
            ok(document);
            const sessionId = "transported-review-session";
            const { displayedVersion } = await preparePlanReviewVersion(fixture.root, plan.name, document.path, {
                runwieldSessionId: sessionId,
            });
            const retained = serializePlanReviewVersion(displayedVersion);
            ok(retained?.source.kind === "individual");
            const review = retained.source.review;
            const oldMeta = {
                cwd: fixture.root,
                planId: plan.planId,
                expectedStatus: review.reviewEvidence?.status,
                expectedWorktree: review.reviewEvidence?.worktree,
                expectedRevision: review.planRevision,
                packageInput: review.packageInput,
                reviewedSource: {
                    planName: plan.name,
                    path: review.planPath,
                    markdown: review.planWithFrontMatter,
                    revision: review.planRevision,
                    attrs: review.originalAttrs,
                },
            };
            const operationId = randomUUID();
            const key = createHash("sha256")
                .update(`${getHomeDir()}:${sessionId}:${operationId}`)
                .digest("hex")
                .slice(0, 40);
            const socket = platform === "win32" ? `\\\\.\\pipe\\runwield-${key}` : `/tmp/runwield-${key}.sock`;
            const restore = async () => {
                const server = createServer((_request, response) => {
                    response.end(
                        JSON.stringify({
                            operationId,
                            events: [],
                            queuedMessages: [],
                            interaction: {
                                type: "plan_review",
                                id: "transported-interaction",
                                _meta: wire === "legacy" ? oldMeta : { planId: plan.planId },
                            },
                            ...(wire === "current" && { reviewVersion: retained }),
                        }),
                    );
                });
                try {
                    await new Promise<void>((resolve, reject) => server.once("error", reject).listen(socket, resolve));
                    const snapshot = await readLiveSessionConnection(sessionId, operationId);
                    return snapshot.interaction?._meta?.displayedVersion;
                } finally {
                    await new Promise<void>((resolve) => server.close(() => resolve()));
                }
            };
            const original = await restore();
            ok(original);
            const intent = { event: "review_approved" as const, approvalAction: "later" as const };
            const committed = await lifecycle.applyEvent(plan.planId, { ...intent, displayedVersion: original });
            equal(committed.approved, true, committed.feedback || "Approval failed");
            const history = await store.history.list(plan.planId);
            equal(history.milestones.length, 1);
            equal((await store.history.read(plan.planId, history.milestones[0].version))["context.md"], plan.body);
            const edited = await store.editBody(plan.planId, {
                expectedRevision: committed.revision!,
                body: "# Persisted edit\n",
            });
            const restored = await restore();
            ok(restored);
            deepEqual(await lifecycle.applyEvent(plan.planId, { ...intent, displayedVersion: restored }), committed);
            equal(
                (
                    await lifecycle.applyEvent(plan.planId, {
                        event: "review_feedback",
                        feedback: "A different intent",
                        displayedVersion: restored,
                    })
                ).cancellationReason,
                "stale_plan_review",
            );
            deepEqual(await store.read(plan.planId), edited);
            equal((await store.history.list(plan.planId)).milestones.length, 1);
        } finally {
            await fixture.cleanup();
        }
    });
}

test("reordering a displayed Plan decision returns its revision and a single approval milestone", async () => {
    const fixture = await packageFixture();
    try {
        const lifecycle = openProjectPlanLifecycle(fixture.identity.projectId, { admitted: fixture.identity });
        const store = openProjectPlanStore(fixture.identity.projectId, { admitted: fixture.identity });
        const plan = await store.create({
            planName: "review",
            contextMarkdown: "Original prose.\n",
            definition: { classification: "PLANNED_CHANGE" },
        });
        const document = await planDocumentsForCheckout(fixture.root).load(plan.name);
        ok(document);
        const { displayedVersion } = await preparePlanReviewVersion(fixture.root, plan.name, document.path);
        const decision = {
            event: "review_approved" as const,
            displayedVersion,
            approvalAction: "later" as const,
            plan: "Approved prose.\n",
        };
        const reordered = {
            plan: decision.plan,
            approvalAction: decision.approvalAction,
            displayedVersion,
            event: decision.event,
        };
        const [approved, repeated] = await Promise.all([
            lifecycle.applyEvent(plan.planId, decision),
            lifecycle.applyEvent(plan.planId, reordered),
        ]);
        equal(approved.approved, true);
        deepEqual(repeated, approved);
        deepEqual(await lifecycle.applyEvent(plan.planId, reordered), approved);
        const changed = await lifecycle.applyEvent(plan.planId, { ...reordered, plan: "Different prose.\n" });
        equal(changed.cancellationReason, "stale_plan_review");
        const current = await store.read(plan.planId);
        equal(current.revision, approved.revision);
        equal(current.body, "Approved prose.\n");
        equal((await store.history.list(plan.planId)).milestones.length, 1);
    } finally {
        await fixture.cleanup();
    }
});

test("a replayed Sequence handoff uses the child attributes from the committed decision", async () => {
    const fixture = await packageFixture();
    try {
        const lifecycle = openProjectPlanLifecycle(fixture.identity.projectId, { admitted: fixture.identity });
        const store = openProjectPlanStore(fixture.identity.projectId, { admitted: fixture.identity });
        const parent = await store.create({
            planName: "sequence",
            contextMarkdown: "# Sequence\n",
            definition: { classification: "PROJECT", type: "sequence" },
        });
        const child = await store.create({
            planName: "sequence/child",
            contextMarkdown: "# Child\n",
            parentPlan: parent.name,
            definition: {
                classification: "PLANNED_CHANGE",
                order: 1,
                executionAgent: "engineer",
                collaborationRecommendation: "autonomous",
            },
        });
        const documents = await prepareSequenceReviewPresentation(fixture.root, parent.name);
        const sessionId = "sequence-session";
        const displayedVersion = await prepareSequenceReviewVersion(fixture.root, parent.name, documents, sessionId);
        const decision = {
            approved: true,
            approvalAction: "run" as const,
            documents: documents.map(({ plan, planId }) => ({ plan, planId })),
        };
        const committed = await applySequencePlanReviewForWorkflow(fixture.root, displayedVersion, decision);
        ok(committed.approved, committed.feedback || "Sequence was not approved");
        equal(committed.sequence?.planAttrs?.executionAgent, "engineer");
        equal(committed.sequence?.planAttrs?.collaborationRecommendation, "autonomous");

        const ready = await store.read(child.planId);
        const newer = await store.revise(child.planId, {
            expectedRevision: ready.revision,
            contextMarkdown: ready.body,
            parentPlan: parent.name,
            definition: {
                classification: "PLANNED_CHANGE",
                order: 1,
                executionAgent: "frontend-engineer",
                collaborationRecommendation: "pair",
            },
        });
        equal(newer.attrs.executionAgent, "frontend-engineer");
        const retained = serializePlanReviewVersion(displayedVersion);
        ok(retained);
        const restored = restorePlanReviewVersion(retained, sessionId);
        ok(restored);
        const replay = await applySequencePlanReviewForWorkflow(fixture.root, restored, decision);
        deepEqual(replay, committed);
        const projected = await lifecycle.applyEvent(parent.planId, {
            ...decision,
            documents: decision.documents.map(({ plan, planId }) => ({ planId, plan })),
            event: "review_approved",
            displayedVersion,
        });
        ok(projected.sequence);
        equal(Object.hasOwn(projected.sequence, "planAttrs"), false);
        equal((await store.read(child.planId)).revision, newer.revision);
    } finally {
        await fixture.cleanup();
    }
});
