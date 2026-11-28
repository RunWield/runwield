import { deepEqual, equal, ok, rejects, throws } from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { inspectOperationReceipt, operationDigest, runReceiptedOperation } from "@runwield/plans/operation-receipts";
import { getPlanRevisionForText, injectFrontMatter, planDocumentMarkdown } from "@runwield/plans/format";
import { packageFixture } from "../shared/testing/plan-package-fixture.ts";
import { loadPlan } from "../shared/testing/plan-query-fixture.ts";
import { seedPlan } from "../shared/testing/plan-state-fixture.ts";
import { withRetainedPlanFixture } from "../shared/testing/retained-plan-fixture.ts";
import { resumeRetainedReviewWrite } from "./review.ts";
import {
    readSequenceOperationResult,
    retainPlanReviewOperationResult,
    retainSequenceOperationResult,
    settleSequenceOperationResult,
} from "./operation-results.ts";

for (const reserved of [false, true]) {
    test(`a review resumes registration ${reserved ? "after" : "before"} its guard was written`, async () => {
        const directory = await mkdtemp(join(tmpdir(), "review-registration-"));
        const operationId = randomUUID();
        const planId = randomUUID();
        const digest = operationDigest(JSON.stringify({ approvalAction: "later", planId }));
        const receipt = join(directory, "operations", `${operationId}.json`);
        const guard = join(directory, "operation-identities", `${operationId}.json`);
        const result = { approved: true, revision: "1".repeat(64) };
        try {
            await mkdir(dirname(receipt));
            await writeFile(
                receipt,
                JSON.stringify({
                    version: 1,
                    operationId,
                    digest,
                    planId,
                    registrationPending: true,
                    outcome: { operationId, status: "unstarted" },
                }),
            );
            if (reserved) {
                await mkdir(dirname(guard));
                await writeFile(guard, JSON.stringify({ digest }));
            }
            equal(inspectOperationReceipt(directory, operationId, planId).status, "unavailable");
            const unexpected = () => Promise.reject(new Error("Review should not run."));
            await rejects(
                runReceiptedOperation(directory, operationId, "2".repeat(64), planId, unexpected, true),
                /different request/,
            );
            const committed = await runReceiptedOperation(
                directory,
                operationId,
                digest,
                planId,
                (recovering) => {
                    equal(recovering, false);
                    equal(inspectOperationReceipt(directory, operationId, planId).status, "pending");
                    retainPlanReviewOperationResult(result);
                    return Promise.resolve({ revision: result.revision });
                },
                true,
            );
            equal(committed.status, "completed");
            deepEqual(await runReceiptedOperation(directory, operationId, digest, planId, unexpected, true), committed);
            await unlink(receipt);
            await rejects(
                runReceiptedOperation(directory, operationId, digest, planId, unexpected, true),
                /Reserved operation evidence is unavailable/,
            );
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });
}

test("the Sequence result driver retains legacy JSON and replays the same decision", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sequence-result-"));
    const operationId = randomUUID();
    const digest = operationDigest(JSON.stringify({ operation: "approve-sequence" }));
    const planId = "sequence-one";
    const result = {
        approved: true,
        revision: "1".repeat(64),
        feedback: "Plan valid — résumé",
        workflowOutcome: { outcome: "approved_execute" as const, planName: "sequence" },
    };
    try {
        settleSequenceOperationResult(directory, "invalid");
        settleSequenceOperationResult(directory, operationId);
        await rejects(
            runReceiptedOperation(
                directory,
                operationId,
                digest,
                planId,
                () => {
                    retainSequenceOperationResult(result);
                    return Promise.reject(new Error("Interrupted after retaining the Sequence decision."));
                },
                true,
            ),
            /Interrupted after retaining/,
        );
        const saved = await readFile(join(directory, "sequence-review-results", operationId + ".json"), "utf8");
        equal(saved, JSON.stringify({ operationId, digest, planId, result }, null, 2) + "\n");
        throws(() => readSequenceOperationResult(directory, operationId, planId), /has not committed/);

        settleSequenceOperationResult(directory, operationId);
        const replay = await runReceiptedOperation(
            directory,
            operationId,
            digest,
            planId,
            () => Promise.reject(new Error("A settled Sequence operation must not rerun.")),
            true,
        );
        equal(replay.status, "completed");
        equal(replay.revision, result.revision);
        deepEqual(readSequenceOperationResult(directory, operationId, planId), result);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

for (const change of ["proven review write", "foreign edit"] as const) {
    test(`retained review restart preserves ${change}`, async () => {
        const fixture = await packageFixture();
        const directory = await mkdtemp(join(tmpdir(), "retained-review-result-"));
        try {
            await withRetainedPlanFixture(fixture.root, async () => {
                const name = "retained-review";
                const planId = "retained-review-plan";
                await seedPlan(fixture.root, name, "# Original\n", {
                    planId,
                    classification: "PLANNED_CHANGE",
                    status: "draft",
                });
                const source = await loadPlan(fixture.root, name);
                ok(source);
                const after = planDocumentMarkdown(
                    injectFrontMatter("# Reviewed\n", { ...source.attrs, status: "approved" }),
                );
                const revision = await getPlanRevisionForText(after);
                const operationId = randomUUID();
                const digest = operationDigest(JSON.stringify({ name, decision: "approved" }));
                const result = { approved: true, revision };
                await rejects(
                    runReceiptedOperation(directory, operationId, digest, planId, () => {
                        retainPlanReviewOperationResult(result, {
                            path: source.path,
                            planId,
                            planName: name,
                            beforeRevision: source.revision,
                            afterRevision: revision,
                            markdown: after,
                            controllerRevision: source.controllerRevision,
                            controllerState: {},
                        });
                        return Promise.reject(new Error("Interrupted after staging the retained review."));
                    }),
                    /Interrupted after staging/,
                );
                const observed =
                    change === "proven review write" ? after : source.markdown.replace("Original", "Outside editing");
                await writeFile(source.path, observed);
                const retry = () =>
                    runReceiptedOperation(directory, operationId, digest, planId, async () => {
                        const applied = await resumeRetainedReviewWrite(fixture.root, {
                            cwd: fixture.root,
                            planName: name,
                            planPath: source.path,
                            planWithFrontMatter: source.markdown,
                            planRevision: source.revision,
                            originalAttrs: source.attrs,
                        });
                        deepEqual(applied, result);
                        return { revision };
                    });
                if (change === "proven review write") equal((await retry()).status, "completed");
                else await rejects(retry(), /Current edits were preserved/);
                equal(await readFile(source.path, "utf8"), observed);
            });
        } finally {
            await Promise.all([fixture.cleanup(), rm(directory, { recursive: true, force: true })]);
        }
    });
}
