import { deepEqual, equal, ok, rejects } from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseProjectId, projects, type HomeProjectOwner } from "@runwield/projects";
import { defineCommittedGitFixture } from "../../test-support/git-test-fixture.ts";
import { currentExecutionRecoveryObservation, withManagedExecutionRecovery } from "./execution-recovery.ts";
import { adoptManagedExecutionReplacement } from "./managed-execution-adoption.ts";
import {
    capturePlanPackageInput,
    createPlanPackage,
    packageWorkflowRevision,
    readPlanPackage,
    updatePlanPackageMetadata,
} from "./package-storage.ts";
import type { ExecutionRecoveryEvidence, ExecutionRecoveryRequest } from "./project-store-wire.ts";

const repository = defineCommittedGitFixture();

async function reserve(owner: HomeProjectOwner, repositoryRoot: string, name: string) {
    const planId = crypto.randomUUID();
    const attemptId = crypto.randomUUID();
    const created = await createPlanPackage(owner, {
        planId,
        name,
        documents: { "context.md": `# ${name}\n`, "validation.md": "" },
    });
    const input = await capturePlanPackageInput(owner, planId);
    const updated = await updatePlanPackageMetadata(owner, planId, created.metadata.revision, {
        workflow: {
            attempt: {
                personalOwner: owner.personalOwner.identity,
                repositoryId: owner.repositoryId,
                repositoryRoot,
                attemptId,
                input: { inputs: [input], definitionHash: "1".repeat(64) },
            },
        },
    });
    const plan = await readPlanPackage(owner, { planId });
    ok(plan.kind === "loaded");
    return { plan, operation: { planId, attemptId, expectedPlanName: name, expectedRevision: updated.revision } };
}

test("canonical recovery observations are isolated by operation and revoked when it ends", async () => {
    const root = await realpath(await repository.checkout());
    const remoteHome = await realpath(await mkdtemp(join(tmpdir(), "execution-recovery-host-")));
    try {
        const local = await projects.checkout.admit(root);
        ok(local.kind === "existing");
        const owner = await projects.home.register({ ...local.identity, displayName: "Recovery scope" });
        const host = {
            projectId: owner.projectId,
            repositoryId: owner.repositoryId,
            repositoryRoot: root,
            personalOwner: { kind: "managed-remote" as const, identity: owner.personalOwner.identity },
        };
        const first = await reserve(owner, root, "first");
        const second = await reserve(owner, root, "second");
        const observe = (request: ExecutionRecoveryRequest): Promise<ExecutionRecoveryEvidence> =>
            Promise.resolve({
                request,
                entry: {
                    id: request.attemptId,
                    planId: request.planId,
                    planName: request.planName,
                    path: join(remoteHome, request.planName),
                    branch: `execution/${request.planName}`,
                    status: request.purpose === "active" ? "active" : "abandoned",
                },
                observedAt: new Date().toISOString(),
            });
        const firstReady = Promise.withResolvers<void>();
        const finishFirst = Promise.withResolvers<void>();
        const releaseDetached = Promise.withResolvers<void>();
        const detachedReads: Promise<ReturnType<typeof currentExecutionRecoveryObservation>>[] = [];
        const refresh = { ...first.operation, action: "refresh" as const };
        const stop = { ...second.operation, action: "stop" as const };
        let applied = false;
        await rejects(
            withManagedExecutionRecovery(
                owner,
                host,
                stop,
                async (request) => {
                    const evidence = await observe(request);
                    return { ...evidence, entry: { ...evidence.entry, id: first.operation.attemptId } };
                },
                () => {
                    applied = true;
                    return Promise.resolve();
                },
            ),
            /proof changed ownership/,
        );
        equal(applied, false);
        equal(currentExecutionRecoveryObservation(owner, second.plan), null);

        const running = withManagedExecutionRecovery(owner, host, refresh, observe, async () => {
            detachedReads.push(
                releaseDetached.promise.then(() => currentExecutionRecoveryObservation(owner, first.plan)),
            );
            firstReady.resolve();
            await finishFirst.promise;
            const selected = await readPlanPackage(owner, { planId: first.operation.planId });
            ok(selected.kind === "loaded");
            const current = currentExecutionRecoveryObservation(owner, selected);
            equal(current?.entry.status, "active");
            equal(current?.entry.id, first.operation.attemptId);
            equal(currentExecutionRecoveryObservation(owner, second.plan), null);
            equal(currentExecutionRecoveryObservation(local.identity, first.plan), null);
            equal(currentExecutionRecoveryObservation(owner, first.plan, undefined, "stop"), null);
            const wrongProject = parseProjectId(crypto.randomUUID());
            ok(wrongProject);
            for (const foreign of [
                { ...owner, projectId: wrongProject },
                { ...owner, repositoryId: crypto.randomUUID() },
                { ...owner, personalOwner: { ...owner.personalOwner, identity: remoteHome } },
            ])
                equal(currentExecutionRecoveryObservation(foreign, first.plan), null);
            const otherAttempt = { ...first.plan.metadata.workflow!.attempt!, attemptId: crypto.randomUUID() };
            equal(currentExecutionRecoveryObservation(owner, first.plan, otherAttempt), null);
        });
        try {
            await Promise.race([firstReady.promise, running]);
            equal(currentExecutionRecoveryObservation(owner, first.plan), null);
            await rejects(
                withManagedExecutionRecovery(owner, host, stop, observe, async () => {
                    detachedReads.push(
                        releaseDetached.promise.then(() => currentExecutionRecoveryObservation(owner, second.plan)),
                    );
                    equal(currentExecutionRecoveryObservation(owner, first.plan), null);
                    const selected = await readPlanPackage(owner, { planId: second.operation.planId });
                    ok(selected.kind === "loaded");
                    equal(currentExecutionRecoveryObservation(owner, selected)?.entry.status, "abandoned");
                    throw new Error("Recovery interrupted.");
                }),
                /Recovery interrupted/,
            );
        } finally {
            finishFirst.resolve();
            try {
                await running;
            } finally {
                releaseDetached.resolve();
            }
        }
        equal(currentExecutionRecoveryObservation(owner, first.plan), null);
        equal(currentExecutionRecoveryObservation(owner, second.plan), null);
        deepEqual(await Promise.all(detachedReads), [null, null]);

        const metadataPath = join(second.plan.path, "plan.wld.json");
        let editedMetadata: string | undefined;
        await rejects(
            withManagedExecutionRecovery(
                owner,
                host,
                stop,
                async (request) => {
                    const evidence = await observe(request);
                    await updatePlanPackageMetadata(owner, stop.planId, stop.expectedRevision, {
                        definition: { ...second.plan.metadata.definition, title: "Edited during host observation" },
                    });
                    editedMetadata = await readFile(metadataPath, "utf8");
                    return evidence;
                },
                () => {
                    applied = true;
                    return Promise.resolve();
                },
            ),
            /does not match the current canonical Plan attempt/,
        );
        equal(applied, false);
        ok(editedMetadata);
        equal(await readFile(metadataPath, "utf8"), editedMetadata);
        const edited = await readPlanPackage(owner, { planId: stop.planId });
        ok(edited.kind === "loaded");
        equal(edited.metadata.revision, stop.expectedRevision + 1);
        equal(edited.metadata.definition.title, "Edited during host observation");
        deepEqual(edited.metadata.workflow?.attempt, second.plan.metadata.workflow?.attempt);
        deepEqual(edited.documents, second.plan.documents);
        equal(currentExecutionRecoveryObservation(owner, edited), null);
    } finally {
        await Promise.all([root, remoteHome].map((path) => rm(path, { recursive: true, force: true })));
    }
});

test("replacement adoption preserves a materialized checklist's original attempt and operation", async () => {
    const root = await realpath(await repository.checkout());
    try {
        const local = await projects.checkout.admit(root);
        ok(local.kind === "existing");
        const owner = await projects.home.register({ ...local.identity, displayName: "Recovery checklist" });
        const host = {
            projectId: owner.projectId,
            repositoryId: owner.repositoryId,
            repositoryRoot: root,
            personalOwner: { kind: "managed-remote" as const, identity: owner.personalOwner.identity },
        };
        const parentPlanId = crypto.randomUUID();
        const planId = crypto.randomUUID();
        const name = "family/child";
        const documents = { "context.md": "# Saved Plan\n", "validation.md": "" };
        const parent = await createPlanPackage(owner, { planId: parentPlanId, name: "family", documents });
        const child = await createPlanPackage(owner, {
            planId,
            name,
            parentPlanId,
            definition: { classification: "PLANNED_CHANGE", status: "failed" },
            documents,
        });
        const input = await capturePlanPackageInput(owner, planId);
        const attemptId = crypto.randomUUID();
        const checklist = join(parent.path, "manual-qa.md");
        const text = "# Generated checklist\n";
        const generated = {
            attemptId,
            operationId: crypto.randomUUID(),
            planId: parentPlanId,
            name: "manual-qa.md" as const,
            beforeHash: null,
            text,
            hash: createHash("sha256").update(text).digest("hex"),
        };
        const bound = await updatePlanPackageMetadata(owner, planId, child.metadata.revision, {
            workflow: {
                attempt: {
                    attemptId,
                    repositoryRoot: root,
                    repositoryId: owner.repositoryId,
                    personalOwner: owner.personalOwner.identity,
                    input: { inputs: [input], definitionHash: "1".repeat(64) },
                },
                generatedArtifact: generated,
            },
        });
        await writeFile(checklist, text);
        const recreate = async (originalAttemptId: string, revision: number) => {
            const selected = await readPlanPackage(owner, { planId });
            ok(selected.kind === "loaded");
            const replacementAttemptId = crypto.randomUUID();
            const operationId = crypto.randomUUID();
            const expectedRevision = packageWorkflowRevision(selected);
            const replacement = { planId, originalAttemptId, operationId, expectedRevision, replacementAttemptId };
            await rejects(adoptManagedExecutionReplacement(owner, replacement), /requires proof/);
            const written = await withManagedExecutionRecovery(
                owner,
                host,
                {
                    planId,
                    attemptId: originalAttemptId,
                    expectedPlanName: name,
                    expectedRevision: revision,
                    action: "recreate",
                    recreate: { operationId, expectedRevision, replacementAttemptId },
                },
                (request) =>
                    Promise.resolve({
                        request,
                        entry: {
                            planId,
                            planName: name,
                            id: replacementAttemptId,
                            status: "active",
                            path: join(root, "replacement"),
                            branch: "replacement",
                            baseBranch: "main",
                            baseCommit: "1".repeat(40),
                            baseTree: "2".repeat(40),
                        },
                        transitionId: operationId,
                        observedAt: new Date().toISOString(),
                    }),
                async () => {
                    await rejects(
                        adoptManagedExecutionReplacement(owner, { ...replacement, operationId: crypto.randomUUID() }),
                        /requires proof/,
                    );
                    return await adoptManagedExecutionReplacement(owner, replacement);
                },
            );
            const after = await readPlanPackage(owner, { planId });
            ok(after.kind === "loaded");
            equal(packageWorkflowRevision(after), written);
            equal(after.metadata.workflow?.attempt?.attemptId, replacementAttemptId);
            equal(after.metadata.definition.status, "ready_for_work");
            deepEqual(after.documents, selected.documents);
            return after;
        };
        const replaced = await recreate(attemptId, bound.revision);
        const replacementId = replaced.metadata.workflow!.attempt!.attemptId;
        deepEqual(replaced.metadata.workflow?.generatedArtifact, { ...generated, reusedByAttemptId: replacementId });
        const changed = await updatePlanPackageMetadata(owner, planId, replaced.metadata.revision, {
            definition: { ...replaced.metadata.definition, status: "failed" },
        });
        const edited = "# User changed this checklist\n";
        await writeFile(checklist, edited);
        const next = await recreate(replacementId, changed.revision);
        equal(next.metadata.workflow?.generatedArtifact, undefined);
        equal(await readFile(checklist, "utf8"), edited);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
